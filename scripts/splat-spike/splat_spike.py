# WS-F5 spike: phone walkthrough video -> Gaussian splat scene, on a Modal GPU.
#
# This is NOT product code. It exists to answer two questions before we build
# the real pipeline (see scripts/splat-spike/README.md):
#   1. What does reconstruction quality look like from a casual 60s phone walkthrough?
#   2. What does one scene actually cost in GPU minutes?
#
# Usage:
#   modal run scripts/splat-spike/splat_spike.py --video walkthrough.mp4 --name lot42-predrywall
#
# Output: scripts/splat-spike/output/<name>.ply + stage timings + cost estimate.

import pathlib
import subprocess
import time

import modal

app = modal.App("arc-splat-spike")

# CUDA devel image so gsplat can JIT-compile its kernels on first run.
# Pins here are a starting point — if the first run fights you over torch/gsplat
# versions, fixing that IS spike work, not a detour.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-devel-ubuntu22.04", add_python="3.10"
    )
    .apt_install("colmap", "ffmpeg", "git", "libglib2.0-0", "libgl1")
    .pip_install("torch==2.1.2", "torchvision==0.16.2")
    .pip_install("nerfstudio==1.1.5")
    .env({"TORCH_CUDA_ARCH_LIST": "8.9"})  # L40S; change if you change the GPU
)

GPU = "L40S"
GPU_USD_PER_HOUR = 1.95  # Modal on-demand L40S rate at time of writing; re-check


@app.function(image=image, gpu=GPU, timeout=3 * 60 * 60)
def reconstruct(video_bytes: bytes, iterations: int) -> dict:
    work = pathlib.Path("/work")
    work.mkdir(exist_ok=True)
    video = work / "input.mp4"
    video.write_bytes(video_bytes)

    timings: dict[str, float] = {}

    def run(stage: str, cmd: list[str]) -> None:
        t0 = time.monotonic()
        subprocess.run(cmd, check=True, cwd=work)
        timings[stage] = time.monotonic() - t0

    # Frames + SfM poses. This is the stage ARKit capture would eliminate —
    # record how long it takes and how often it fails; that number is the
    # argument for the ARKit session capture format.
    run(
        "sfm (ns-process-data)",
        [
            "ns-process-data", "video",
            "--data", str(video),
            "--output-dir", str(work / "processed"),
            "--num-frames-target", "300",
            "--matching-method", "sequential",
        ],
    )

    run(
        "train (splatfacto)",
        [
            "ns-train", "splatfacto",
            "--data", str(work / "processed"),
            "--output-dir", str(work / "outputs"),
            "--max-num-iterations", str(iterations),
            "--viewer.quit-on-train-completion", "True",
        ],
    )

    config = next((work / "outputs").rglob("config.yml"))
    run(
        "export",
        [
            "ns-export", "gaussian-splat",
            "--load-config", str(config),
            "--output-dir", str(work / "export"),
        ],
    )

    ply = next((work / "export").glob("*.ply"))
    return {"ply": ply.read_bytes(), "timings": timings}


@app.local_entrypoint()
def main(video: str, name: str = "scene", iterations: int = 15000):
    video_path = pathlib.Path(video)
    t0 = time.monotonic()
    result = reconstruct.remote(video_path.read_bytes(), iterations)
    wall = time.monotonic() - t0

    out_dir = pathlib.Path(__file__).parent / "output"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{name}.ply"
    out.write_bytes(result["ply"])

    gpu_seconds = sum(result["timings"].values())
    print(f"\nScene written to {out} ({out.stat().st_size / 1e6:.1f} MB)")
    for stage, secs in result["timings"].items():
        print(f"  {stage}: {secs / 60:.1f} min")
    print(f"  total GPU time: {gpu_seconds / 60:.1f} min "
          f"(~${gpu_seconds / 3600 * GPU_USD_PER_HOUR:.2f} at {GPU} on-demand)")
    print(f"  wall clock incl. upload/queue: {wall / 60:.1f} min")
    print("\nView it: cd scripts/splat-spike/viewer && python3 -m http.server 8321")
