import unittest
from unittest.mock import Mock

import numpy as np
import torch
from PIL import Image

from scripts.video_worker import (
    ANIMATEDIFF_MOTION_SCALE,
    SVD_DECODE_CHUNK_SIZE,
    enable_optional_vae_optimizations,
    enable_svd_low_memory_mode,
    frame_signal_metrics,
    scale_animatediff_motion,
    validate_generated_frames,
)


class VideoWorkerTests(unittest.TestCase):
    def test_enables_svd_forward_chunking(self):
        pipe = Mock()

        enable_svd_low_memory_mode(pipe)

        pipe.unet.enable_forward_chunking.assert_called_once_with()
        self.assertEqual(SVD_DECODE_CHUNK_SIZE, 1)

    def test_skips_unsupported_vae_tiling_and_enables_slicing(self):
        vae = Mock()
        vae.enable_tiling.side_effect = NotImplementedError
        pipe = Mock(vae=vae)

        enabled = enable_optional_vae_optimizations(pipe)

        self.assertEqual(enabled, ["slicing"])
        vae.enable_tiling.assert_called_once_with()
        vae.enable_slicing.assert_called_once_with()

    def test_does_not_hide_unexpected_vae_errors(self):
        vae = Mock()
        vae.enable_tiling.side_effect = RuntimeError("broken VAE")
        pipe = Mock(vae=vae)

        with self.assertRaisesRegex(RuntimeError, "broken VAE"):
            enable_optional_vae_optimizations(pipe)

    def test_scales_only_motion_projection_weights(self):
        projection = torch.nn.Linear(2, 2, bias=True)
        projection.weight.data.fill_(1)
        projection.bias.data.fill_(1)
        untouched = torch.nn.Linear(2, 2, bias=False)

        pipe = Mock()
        pipe.unet.named_modules.return_value = [
            ("down_blocks.0.motion_modules.0", Mock(proj_out=projection)),
            ("down_blocks.0.attentions.0", Mock(proj_out=untouched)),
        ]

        count = scale_animatediff_motion(pipe)

        self.assertEqual(count, 1)
        self.assertTrue(torch.all(projection.weight == ANIMATEDIFF_MOTION_SCALE))
        self.assertTrue(torch.all(projection.bias == ANIMATEDIFF_MOTION_SCALE))
        self.assertTrue(torch.all(untouched.weight != ANIMATEDIFF_MOTION_SCALE))

    def test_rejects_collapsed_animatediff_frames(self):
        frames = [Image.fromarray(np.full((32, 32, 3), 70, dtype=np.uint8)) for _ in range(4)]

        with self.assertRaisesRegex(RuntimeError, "collapsed low-detail frames"):
            validate_generated_frames("animatediff-sd15", frames)

    def test_accepts_detailed_color_frames(self):
        gradient = np.zeros((32, 32, 3), dtype=np.uint8)
        gradient[:, :, 0] = np.arange(32, dtype=np.uint8)[:, None] * 8
        gradient[:, :, 1] = 180
        frames = [Image.fromarray(np.roll(gradient, index, axis=1)) for index in range(4)]

        metrics = validate_generated_frames("animatediff-sd15", frames)

        self.assertGreater(metrics["standardDeviation"], 12)
        self.assertGreater(metrics["meanSaturation"], 8)

    def test_reports_frame_signal_metrics(self):
        frames = [
            Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)),
            Image.fromarray(np.full((4, 4, 3), 255, dtype=np.uint8)),
        ]

        metrics = frame_signal_metrics(frames)

        self.assertAlmostEqual(metrics["standardDeviation"], 127.5)
        self.assertEqual(metrics["meanSaturation"], 0)


if __name__ == "__main__":
    unittest.main()
