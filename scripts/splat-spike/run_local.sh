#!/usr/bin/env bash
# WS-F5 spike, local path (Apple Silicon): video -> COLMAP dataset -> train with Brush.
# Answers the QUALITY question without any cloud account. For the $/scene question,
# use splat_spike.py (Modal) — production will run on external GPUs either way.
#
# usage: ./run_local.sh walkthrough.mp4 [name]
set -euo pipefail

VIDEO="${1:?usage: ./run_local.sh <video> [name]}"
NAME="${2:-scene}"
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$SPIKE_DIR/output/$NAME"
FRAMES=300

for dep in ffmpeg ffprobe colmap; do
  command -v "$dep" >/dev/null || { echo "missing $dep — brew install ffmpeg colmap"; exit 1; }
done

mkdir -p "$WORK/images"

echo "== frames (targeting ~$FRAMES) =="
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")
FPS=$(python3 -c "print(max(1, min(10, $FRAMES / $DURATION)))")
ffmpeg -y -loglevel error -i "$VIDEO" -vf "fps=$FPS" -q:v 2 "$WORK/images/%04d.jpg"
echo "extracted $(ls "$WORK/images" | wc -l | tr -d ' ') frames"

# CPU SIFT — no CUDA on macOS. Sequential matcher fits walkthrough footage
# (consecutive frames overlap) and keeps CPU matching tractable.
echo "== colmap: features =="
time colmap feature_extractor \
  --database_path "$WORK/db.db" --image_path "$WORK/images" \
  --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV \
  --FeatureExtraction.use_gpu 0

echo "== colmap: matching =="
time colmap sequential_matcher \
  --database_path "$WORK/db.db" \
  --SequentialMatching.loop_detection 0 \
  --FeatureMatching.use_gpu 0

echo "== colmap: mapping =="
mkdir -p "$WORK/sparse"
time colmap mapper \
  --database_path "$WORK/db.db" --image_path "$WORK/images" \
  --output_path "$WORK/sparse"

[ -d "$WORK/sparse/0" ] || { echo "SfM produced no model — capture likely too sloppy. That itself is a spike finding: log it."; exit 1; }
REGISTERED=$(colmap model_analyzer --path "$WORK/sparse/0" 2>&1 | grep -i "registered" || true)
echo "SfM done. $REGISTERED"

cat <<EOF

Dataset ready: $WORK  (images/ + sparse/0 — standard COLMAP layout)

Train it with Brush (Gaussian-splat trainer, runs on Metal):
  https://github.com/ArthurBrussee/brush — grab a macOS release binary,
  open the app, load the dataset folder above, train (default steps are fine),
  then export the .ply.

View the .ply:
  cd $SPIKE_DIR/viewer && python3 -m http.server 8321

Record in the README metrics table: SfM minutes (printed above by 'time'),
frames registered vs extracted, train minutes, and subjective quality.
EOF
