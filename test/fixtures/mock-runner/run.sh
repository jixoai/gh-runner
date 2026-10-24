#!/bin/bash
# mock Runner.Listener（E2E fixture）：以真实日志形态（diag 包裹 + stdout 双写）模拟生命周期。
# 用法：run.sh [jobName] [result]
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
DIAG="$DIR/_diag"
mkdir -p "$DIAG"
JOB="${1:-e2e-job}"
RESULT="${2:-Succeeded}"

ts() { date -u +"%Y-%m-%d %H:%M:%S"; }
diag() { echo "[$(ts)Z INFO Terminal] WRITE LINE: $(ts)Z: $1" >> "$DIAG_LOG"; }
out() { echo "$(ts)Z: $1"; }

DIAG_LOG="$DIAG/Runner_$(date -u +%Y%m%d-%H%M%S)-utc.log"
diag "Current runner version: '2.338.1'"

term() { diag "Listening for Jobs"; exit 0; }
trap term TERM INT

diag "Listening for Jobs"
out "Listening for Jobs"
sleep 1
diag "Running job: $JOB"
out "Running job: $JOB"
sleep 2
diag "Job $JOB completed with result: $RESULT"
out "Job $JOB completed with result: $RESULT"
diag "Listening for Jobs"
out "Listening for Jobs"
while true; do sleep 0.5; done
