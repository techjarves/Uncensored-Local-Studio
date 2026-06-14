#!/usr/bin/env python3
"""Persistent local CUDA video generation worker.

Protocol: newline-delimited JSON on stdin/stdout. Human-readable logs go to stderr.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch
import numpy as np
from diffusers import (
    AnimateDiffPipeline,
    DDIMScheduler,
    MotionAdapter,
    StableVideoDiffusionPipeline,
    WanImageToVideoPipeline,
    WanPipeline,
)
from diffusers.utils import export_to_video, load_image

ANIMATEDIFF_MOTION_SCALE = 0.20
SVD_DECODE_CHUNK_SIZE = 1


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True), flush=True)


def log(message: str) -> None:
    print(f"[video-worker] {message}", file=sys.stderr, flush=True)


def scale_animatediff_motion(pipe: Any, scale: float = ANIMATEDIFF_MOTION_SCALE) -> int:
    """Reduce motion residual strength to avoid FP16 scene collapse on SD 1.5 checkpoints."""
    scaled = 0
    with torch.no_grad():
        for name, module in pipe.unet.named_modules():
            if "motion_modules" not in name or not hasattr(module, "proj_out"):
                continue
            projection = module.proj_out
            if hasattr(projection, "weight"):
                projection.weight.mul_(scale)
            if getattr(projection, "bias", None) is not None:
                projection.bias.mul_(scale)
            scaled += 1
    return scaled


def frame_signal_metrics(frames: list[Any]) -> dict[str, float]:
    pixels = np.stack([np.asarray(frame, dtype=np.float32) for frame in frames])
    saturation = pixels.max(axis=-1) - pixels.min(axis=-1)
    return {
        "standardDeviation": float(pixels.std()),
        "meanSaturation": float(saturation.mean()),
    }


def validate_generated_frames(model_id: str, frames: list[Any]) -> dict[str, float]:
    metrics = frame_signal_metrics(frames)
    if (
        model_id == "animatediff-sd15"
        and metrics["standardDeviation"] < 12
        and metrics["meanSaturation"] < 8
    ):
        raise RuntimeError(
            "AnimateDiff produced collapsed low-detail frames. Try a different compatible "
            "SD 1.5 base model or seed."
        )
    return metrics


def enable_optional_vae_optimizations(pipe: Any) -> list[str]:
    enabled = []
    vae = getattr(pipe, "vae", None)
    if vae is None:
        return enabled

    for name, method_name in (
        ("tiling", "enable_tiling"),
        ("slicing", "enable_slicing"),
    ):
        method = getattr(vae, method_name, None)
        if not callable(method):
            continue
        try:
            method()
            enabled.append(name)
        except NotImplementedError:
            log(f"Skipping unsupported VAE {name} for {vae.__class__.__name__}.")
    return enabled


def enable_svd_low_memory_mode(pipe: Any) -> None:
    enable_forward_chunking = getattr(getattr(pipe, "unet", None), "enable_forward_chunking", None)
    if callable(enable_forward_chunking):
        enable_forward_chunking()
        log("Enabled SVD UNet forward chunking.")


class CancelledError(RuntimeError):
    pass


class Worker:
    def __init__(self, models_dir: Path, outputs_dir: Path) -> None:
        self.models_dir = models_dir
        self.outputs_dir = outputs_dir
        self.cancel_event = threading.Event()
        self.active_job: str | None = None
        self.thread: threading.Thread | None = None
        self.pipeline: Any = None
        self.pipeline_key: str | None = None
        self.commands: queue.Queue[dict[str, Any]] = queue.Queue()
        self.progress_lock = threading.Lock()
        self.progress_state: dict[str, Any] = {}

    def cleanup_cuda(self, unload: bool = False) -> None:
        if unload:
            self.pipeline = None
            self.pipeline_key = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise CancelledError("Video generation cancelled.")

    def report_progress(
        self,
        job_id: str,
        phase: str,
        progress: int,
        current: int = 0,
        total: int = 0,
        started: float | None = None,
    ) -> None:
        payload = {
            "type": "job-progress",
            "jobId": job_id,
            "phase": phase,
            "progress": progress,
            "current": current,
            "total": total,
        }
        if started is not None:
            payload["elapsedSec"] = round(time.time() - started, 1)
        with self.progress_lock:
            self.progress_state = payload
        emit(payload)

    def progress_heartbeat(self, stop_event: threading.Event, started: float) -> None:
        while not stop_event.wait(2):
            with self.progress_lock:
                payload = dict(self.progress_state)
            if payload:
                payload["elapsedSec"] = round(time.time() - started, 1)
                emit(payload)

    def progress_callback(self, job_id: str, total_steps: int):
        def callback(_pipeline, step: int, _timestep, callback_kwargs):
            self.check_cancelled()
            current = min(total_steps, step + 1)
            progress = 20 + int((current / max(1, total_steps)) * 70)
            self.report_progress(job_id, "Generating frames", progress, current, total_steps)
            return callback_kwargs

        return callback

    def load_pipeline(self, request: dict[str, Any]) -> Any:
        model_id = request["modelId"]
        model_path = self.models_dir / model_id
        mode = request["mode"]
        base_model = request.get("baseModelPath")
        key = f"{model_id}:{mode}:{base_model or ''}"
        if self.pipeline is not None and self.pipeline_key == key:
            return self.pipeline

        self.cleanup_cuda(unload=True)
        self.check_cancelled()
        self.report_progress(request["jobId"], "Loading video model", 7)

        if model_id == "animatediff-sd15":
            if not base_model:
                raise ValueError("AnimateDiff requires a compatible local SD 1.5 .safetensors or .ckpt model.")
            self.report_progress(request["jobId"], "Loading AnimateDiff motion adapter", 9)
            adapter = MotionAdapter.from_pretrained(
                str(model_path),
                local_files_only=True,
                torch_dtype=torch.float16,
                variant="fp16",
            )
            self.report_progress(request["jobId"], "Loading SD 1.5 checkpoint", 12)
            pipe = AnimateDiffPipeline.from_single_file(
                base_model,
                motion_adapter=adapter,
                local_files_only=True,
                torch_dtype=torch.float16,
            )
            pipe.scheduler = DDIMScheduler.from_config(
                pipe.scheduler.config,
                beta_schedule="linear",
                clip_sample=False,
                timestep_spacing="linspace",
                steps_offset=1,
            )
            scaled_modules = scale_animatediff_motion(pipe)
            log(
                f"Scaled {scaled_modules} AnimateDiff motion projections "
                f"to {ANIMATEDIFF_MOTION_SCALE:.2f}."
            )
        elif model_id == "svd-xt":
            self.report_progress(request["jobId"], "Loading Stable Video Diffusion", 10)
            pipe = StableVideoDiffusionPipeline.from_pretrained(
                str(model_path),
                local_files_only=True,
                torch_dtype=torch.float16,
                variant="fp16",
            )
            enable_svd_low_memory_mode(pipe)
        elif model_id == "wan2.2-ti2v-5b":
            self.report_progress(request["jobId"], "Loading Wan 2.2 pipeline", 10)
            pipeline_cls = WanImageToVideoPipeline if mode == "image-to-video" else WanPipeline
            pipe = pipeline_cls.from_pretrained(
                str(model_path),
                local_files_only=True,
                torch_dtype=torch.bfloat16,
            )
        else:
            raise ValueError(f"Unsupported video model: {model_id}")

        if hasattr(pipe, "enable_model_cpu_offload"):
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
        enabled_optimizations = enable_optional_vae_optimizations(pipe)
        if enabled_optimizations:
            log(f"Enabled VAE optimizations: {', '.join(enabled_optimizations)}.")

        self.pipeline = pipe
        self.pipeline_key = key
        self.report_progress(request["jobId"], "Model ready", 18)
        return pipe

    def generate(self, request: dict[str, Any]) -> None:
        job_id = request["jobId"]
        started = time.time()
        heartbeat_stop = threading.Event()
        self.progress_state = {}
        self.report_progress(job_id, "Preparing video pipeline", 6, started=started)
        heartbeat = threading.Thread(
            target=self.progress_heartbeat,
            args=(heartbeat_stop, started),
            daemon=True,
        )
        heartbeat.start()
        seed = int(request["seed"])
        generator = torch.Generator(device="cpu").manual_seed(seed)
        try:
            pipe = self.load_pipeline(request)
            self.check_cancelled()
            steps = int(request["steps"])
            kwargs: dict[str, Any] = {
                "prompt": request["prompt"],
                "num_inference_steps": steps,
                "generator": generator,
                "callback_on_step_end": self.progress_callback(job_id, steps),
            }
            negative_prompt = request.get("negativePrompt", "")
            if negative_prompt:
                kwargs["negative_prompt"] = negative_prompt

            model_id = request["modelId"]
            if model_id == "animatediff-sd15":
                kwargs.update({
                    "height": int(request["height"]),
                    "width": int(request["width"]),
                    "num_frames": int(request["frames"]),
                    "guidance_scale": float(request["guidance"]),
                })
            elif model_id == "svd-xt":
                image = load_image(request["inputImagePath"]).convert("RGB")
                image = image.resize((int(request["width"]), int(request["height"])))
                kwargs = {
                    "image": image,
                    "height": int(request["height"]),
                    "width": int(request["width"]),
                    "num_frames": int(request["frames"]),
                    "num_inference_steps": steps,
                    "generator": generator,
                    "decode_chunk_size": SVD_DECODE_CHUNK_SIZE,
                    "motion_bucket_id": int(request.get("motionBucketId", 127)),
                    "noise_aug_strength": float(request.get("noiseAugStrength", 0.02)),
                    "callback_on_step_end": self.progress_callback(job_id, steps),
                }
            elif model_id == "wan2.2-ti2v-5b":
                kwargs.update({
                    "height": int(request["height"]),
                    "width": int(request["width"]),
                    "num_frames": int(request["frames"]),
                    "guidance_scale": float(request["guidance"]),
                })
                if request["mode"] == "image-to-video":
                    kwargs["image"] = load_image(request["inputImagePath"]).convert("RGB")

            result = pipe(**kwargs)
            self.check_cancelled()
            frames = result.frames[0]
            signal_metrics = validate_generated_frames(model_id, frames)
            self.report_progress(job_id, "Encoding MP4", 94, started=started)

            output_name = f"video-{int(time.time())}-{seed}-{uuid.uuid4().hex[:8]}.mp4"
            temp_path = self.outputs_dir / f"{output_name}.part.mp4"
            final_path = self.outputs_dir / output_name
            export_to_video(frames, str(temp_path), fps=int(request["fps"]))
            os.replace(temp_path, final_path)

            metadata = {
                "id": job_id,
                "video": output_name,
                "prompt": request["prompt"],
                "negativePrompt": negative_prompt,
                "modelId": model_id,
                "mode": request["mode"],
                "seed": seed,
                "width": int(request["width"]),
                "height": int(request["height"]),
                "frames": int(request["frames"]),
                "fps": int(request["fps"]),
                "duration": round(int(request["frames"]) / int(request["fps"]), 2),
                "generationTimeSec": round(time.time() - started, 2),
                "frameSignal": signal_metrics,
                "motionScale": ANIMATEDIFF_MOTION_SCALE if model_id == "animatediff-sd15" else None,
                "sourceImage": Path(request["inputImagePath"]).name if request.get("inputImagePath") else None,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            metadata_path = self.outputs_dir / f"{output_name}.json"
            temp_metadata = metadata_path.with_suffix(metadata_path.suffix + ".part")
            temp_metadata.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            os.replace(temp_metadata, metadata_path)
            emit({"type": "job-complete", "jobId": job_id, "progress": 100, "output": metadata})
        except CancelledError as exc:
            emit({"type": "job-cancelled", "jobId": job_id, "error": str(exc)})
        except torch.OutOfMemoryError:
            self.cleanup_cuda(unload=True)
            emit({
                "type": "job-error",
                "jobId": job_id,
                "error": "CUDA ran out of memory. Close other GPU applications or choose a smaller video profile.",
            })
        except Exception as exc:
            log(traceback.format_exc())
            emit({"type": "job-error", "jobId": job_id, "error": str(exc)})
        finally:
            heartbeat_stop.set()
            self.cleanup_cuda()
            self.active_job = None
            self.cancel_event.clear()
            with self.progress_lock:
                self.progress_state = {}

    def handle(self, command: dict[str, Any]) -> bool:
        kind = command.get("command")
        if kind == "generate":
            if self.active_job is not None:
                emit({"type": "job-error", "jobId": command.get("jobId"), "error": "A video job is already active."})
                return True
            self.active_job = command["jobId"]
            self.cancel_event.clear()
            self.thread = threading.Thread(target=self.generate, args=(command,), daemon=True)
            self.thread.start()
        elif kind == "cancel":
            if self.active_job == command.get("jobId"):
                self.cancel_event.set()
        elif kind == "unload":
            if self.active_job:
                self.cancel_event.set()
            self.cleanup_cuda(unload=True)
            emit({"type": "worker-unloaded"})
        elif kind == "shutdown":
            self.cancel_event.set()
            if self.thread and self.thread.is_alive():
                self.thread.join(timeout=10)
            self.cleanup_cuda(unload=True)
            return False
        return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True, type=Path)
    parser.add_argument("--outputs-dir", required=True, type=Path)
    args = parser.parse_args()
    args.models_dir.mkdir(parents=True, exist_ok=True)
    args.outputs_dir.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        emit({"type": "worker-error", "error": "CUDA is not available."})
        return 2

    worker = Worker(args.models_dir, args.outputs_dir)
    emit({
        "type": "worker-ready",
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "vramBytes": torch.cuda.get_device_properties(0).total_memory,
    })
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if not worker.handle(command):
                break
        except Exception as exc:
            emit({"type": "worker-error", "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
