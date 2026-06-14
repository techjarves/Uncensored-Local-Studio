import argparse
import base64
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

import openvino as ov
import openvino_genai as genai
from PIL import Image


class WorkerState:
    def __init__(self, model_dir: Path, width: int, height: int, cache_dir: Path):
        self.model_dir = model_dir
        self.width = width
        self.height = height
        self.cache_dir = cache_dir
        self.ready = False
        self.error = None
        self.pipeline = None
        self.devices = {}
        self.started_at = time.time()

    def load(self) -> None:
        try:
            available_devices = ov.Core().available_devices
            if "NPU" not in available_devices:
                raise RuntimeError(
                    f"Intel NPU is not available to OpenVINO. Devices: {', '.join(available_devices)}"
                )
            vae_device = "GPU" if "GPU" in available_devices else "CPU"
            self.devices = {
                "text_encoder": "CPU",
                "unet": "NPU",
                "vae_decoder": vae_device,
            }
            print(f"[openvino-npu] Loading model: {self.model_dir}", flush=True)
            print(
                "[openvino-npu] Devices: "
                f"text_encoder=CPU, unet=NPU, vae_decoder={vae_device}",
                flush=True,
            )
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            pipe = genai.Text2ImagePipeline(str(self.model_dir))
            pipe.reshape(1, self.height, self.width, 1.0)
            pipe.compile(
                "CPU",
                "NPU",
                vae_device,
                config={"CACHE_DIR": str(self.cache_dir)},
            )
            self.pipeline = pipe
            self.ready = True
            print("[openvino-npu] READY", flush=True)
        except Exception as exc:
            self.error = str(exc)
            print(f"[openvino-npu] ERROR: {self.error}", file=sys.stderr, flush=True)
            raise


def make_handler(state: WorkerState):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, {
                    "ok": state.ready and not state.error,
                    "ready": state.ready,
                    "error": state.error,
                    "model": str(state.model_dir),
                    "devices": state.devices,
                    "uptime_sec": round(time.time() - state.started_at, 1),
                })
                return
            self._json(404, {"ok": False, "error": "Unknown endpoint"})

        def do_POST(self) -> None:
            if self.path != "/generate":
                self._json(404, {"ok": False, "error": "Unknown endpoint"})
                return
            if not state.ready or state.pipeline is None:
                self._json(503, {"ok": False, "error": state.error or "OpenVINO NPU worker is not ready"})
                return

            length = int(self.headers.get("Content-Length", "0") or "0")
            try:
                request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                prompt = str(request.get("prompt") or "").strip()
                if not prompt:
                    raise ValueError("Prompt is required")
                steps = max(1, min(8, int(request.get("steps") or 4)))
                guidance_scale = float(request.get("guidance_scale") or request.get("cfg_scale") or 1.0)
                width = int(request.get("width") or state.width)
                height = int(request.get("height") or state.height)
                if (width, height) not in ((512, 512), (1024, 1024)):
                    raise ValueError("OpenVINO NPU supports 512x512 generation or 1024x1024 HD upscale.")

                started = time.time()
                last_step_at = started

                def progress_callback(step: int, num_steps: int, _latent) -> bool:
                    nonlocal last_step_at
                    now = time.time()
                    step_duration = max(0.001, now - last_step_at)
                    last_step_at = now
                    print(
                        f"[openvino-npu] PROGRESS {step + 1}/{num_steps} {1.0 / step_duration:.2f} it/s",
                        flush=True,
                    )
                    return False

                generate_args = {
                    "width": state.width,
                    "height": state.height,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance_scale,
                    "rng_seed": int(request.get("seed")) if request.get("seed") not in (None, -1) else int(time.time_ns() % (2**32)),
                    "callback": progress_callback,
                }
                negative_prompt = str(request.get("negative_prompt") or "").strip()
                if negative_prompt and guidance_scale > 1.0:
                    generate_args["negative_prompt"] = negative_prompt
                image_tensor = state.pipeline.generate(prompt, **generate_args)
                print("[openvino-npu] DECODING", flush=True)
                image = Image.fromarray(image_tensor.data[0])
                upscaled = width != state.width or height != state.height
                if upscaled:
                    image = image.resize((width, height), Image.Resampling.LANCZOS)
                buf = BytesIO()
                image.save(buf, format="PNG")
                encoded = base64.b64encode(buf.getvalue()).decode("ascii")
                self._json(200, {
                    "ok": True,
                    "data": [{
                        "b64_json": encoded,
                        "seed": request.get("seed"),
                    }],
                    "generated_size": f"{state.width}x{state.height}",
                    "output_size": f"{width}x{height}",
                    "upscaled": upscaled,
                    "duration_sec": round(time.time() - started, 2),
                })
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc)})

        def log_message(self, fmt: str, *args) -> None:
            print(f"[openvino-npu-http] {fmt % args}", flush=True)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--cache-dir", type=Path, default=Path("app/tools/openvino-cache"))
    args = parser.parse_args()

    state = WorkerState(args.model_dir, args.width, args.height, args.cache_dir)
    state.load()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state))
    print(f"[openvino-npu] Listening on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
