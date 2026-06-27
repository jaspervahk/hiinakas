#!/bin/bash
# Core training loop — called by train-manager.sh (do not run directly).
#
# Each iteration:
#   1. Generate self-play games → data/batch_NNNN.bin
#   2. Train value network on all accumulated data → models/policy.bin
#   3. Deploy model via Firebase Hosting → /models/policy.bin

set -euo pipefail

PROJECTDIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECTDIR"

GAMES="${GAMES:-5000}"
EPOCHS="${EPOCHS:-20}"
PLAYERS="${PLAYERS:-2}"
WINDOW="${WINDOW:-20}"   # train on the last N batches only — prevents mixing old/new policy data

# Resume from the highest existing batch number so restarts never overwrite data.
ITER=$(ls data/batch_*.bin 2>/dev/null | sed 's/.*batch_0*//' | sed 's/\.bin//' | sort -n | tail -1)
ITER="${ITER:-0}"
echo "Resuming from iteration $ITER ($(ls data/batch_*.bin 2>/dev/null | wc -l | tr -d ' ') existing batches)"

echo "=== Hiinakas GTO Training ==="
echo "Games/iter: $GAMES | Epochs: $EPOCHS | Players: $PLAYERS"
echo "Started at: $(date)"

while true; do
  ITER=$((ITER + 1))
  BATCH="data/batch_$(printf '%04d' $ITER).bin"

  echo ""
  echo "────────── Iteration $ITER — $(date '+%H:%M:%S') ──────────"

  echo "[1/3] Self-play ($GAMES games, policy: $([ -f models/policy.bin ] && echo NN || echo heuristic))…"
  npx tsx scripts/selfplay.ts --games "$GAMES" --players "$PLAYERS" --out "$BATCH"

  TOTAL_BATCHES=$(ls data/*.bin 2>/dev/null | wc -l | tr -d ' ')
  echo "[2/3] Training ($EPOCHS epochs on last $WINDOW of $TOTAL_BATCHES batches, warm-start: $([ -f models/policy.bin ] && echo yes || echo no))…"
  python3 scripts/train.py \
    --data data/ \
    --out models/policy.bin \
    --resume models/policy.bin \
    --epochs "$EPOCHS" \
    --batch 512 \
    --window "$WINDOW"

  echo "[3/3] Deploying model via Hosting…"
  mkdir -p dist/models
  cp models/policy.bin dist/models/policy.bin
  firebase deploy --only hosting --project hiinakas-355 --non-interactive 2>&1 \
    | grep -E 'complete|error|Deploy|release' || true
  echo "Deployed → /models/policy.bin (iteration $ITER)"
done
