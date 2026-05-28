import logging
import os
import sys


def get_demucs_device() -> str:
    forced_device = os.getenv("DEMUCS_DEVICE")
    if forced_device:
        return forced_device

    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        if (
            os.getenv("DEMUCS_ENABLE_XPU") == "1"
            and hasattr(torch, "xpu")
            and torch.xpu.is_available()
        ):
            return "xpu"
    except Exception as exc:
        logging.warning("Unable to detect Demucs accelerator: %s", exc)

    return "cpu"


def demucs_python() -> str:
    return sys.executable
