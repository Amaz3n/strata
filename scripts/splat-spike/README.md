# WS-F5 spike — Gaussian splats from a phone walkthrough

Companion to `docs/tech-frontier-gameplan.md` § WS-F5. This spike exists to answer
two questions **before** any product code (tables, outbox jobs, iOS capture UX,
viewer route) gets built:

1. **Quality:** what does reconstruction look like from a *casual, untrained*
   60-second phone walkthrough of a house under construction?
2. **Cost:** what does one scene cost in GPU minutes?

Those answers decide the pricing model, the capture UX, and whether the capture
format must be an ARKit session recording (poses + optional LiDAR depth) rather
than plain video. Nothing here is product code; delete this directory when WS-F5
phase 1 lands.

**Modal (cloud GPU) is the main path** — one command, unattended, answers both
questions, and matches production's shape (the real pipeline calls external GPUs
regardless; Vercel has none). A local Apple Silicon fallback exists at the
bottom for running without a cloud account.

## One-time setup

```bash
pip install modal
```

```bash
modal setup
```

`modal setup` opens a browser to authenticate against your Modal account
(create one at modal.com if needed — free tier includes GPU credit, enough for
several runs).

## Run

```bash
modal run scripts/splat-spike/splat_spike.py --video walkthrough.mp4 --name lot42-predrywall
```

First run builds the image and JIT-compiles gsplat's CUDA kernels (~10 min,
one-time). Output lands in `scripts/splat-spike/output/<name>.ply` and the run
prints per-stage timings plus a dollar estimate.

`--iterations` defaults to 15000 (fast, decent). Try 30000 on the best capture
to see the quality ceiling.

## View

```bash
cd scripts/splat-spike/viewer && python3 -m http.server 8321
```

Open http://localhost:8321 and drop the `.ply` in. (Serve it — workers don't
run from `file://`.)

## Capture protocol (shoot 3–4 test videos)

Shoot with a normal iPhone camera app, 1080p30, landscape:

- Walk slowly and continuously — one steady lap of the space, ~60–90s.
- Keep the camera moving *sideways/forward*, not just rotating in place
  (pure rotation gives SfM nothing to triangulate).
- Overlap: each doorway/corner should appear from several angles.
- Include at least one hard case on purpose: a textureless drywalled room, a
  repetitive stud wall, a dim space. Those are the real-world failure modes.

Vary the captures: one careful, one deliberately sloppy (the "untrained super"
simulation), one pre-drywall if you can get one.

## What to record per run (the spike's actual deliverable)

| Metric | Why it matters |
|---|---|
| SfM stage minutes + did it fail | The whole argument for ARKit-session capture vs plain video |
| Train + export minutes | Dominates per-scene cost |
| $ per scene | Sets the metering/plan-inclusion model |
| Wall clock upload→viewable | The <15 min acceptance bar |
| Subjective quality on the sloppy capture | Decides how much guided-capture UX phase 1 needs |
| Floaters/artifacts in textureless rooms | Decides whether LiDAR depth priors are needed early |

## Fallback: run locally (no cloud account)

ffmpeg + COLMAP are installed (brew). Download **Brush** (splat trainer on
Metal) from https://github.com/ArthurBrussee/brush/releases, then:

```bash
./scripts/splat-spike/run_local.sh walkthrough.mp4 lot42-predrywall
```

Extracts ~300 frames, runs CPU COLMAP (15–40 min), leaves a COLMAP dataset in
`output/<name>/` — open it in Brush, train, export the `.ply`. Answers quality
only; use Modal for $/scene.

## Decision after the runs

- SfM slow/flaky on realistic captures → capture format is **ARKit session
  recording** (poses + intrinsics + optional LiDAR depth), plain video demoted
  to fallback; pipeline front-end changes accordingly.
- Quality unacceptable from sloppy capture even at 30k iterations → guided
  capture UX moves from phase 2 into phase 1.
- $/scene and minutes/scene → plug into the WS-F5 cost model bullet.
