#!/bin/bash
# Training process manager.
#
# Usage:
#   npm run training start     — start training in the background
#   npm run training stop      — stop training
#   npm run training status    — show running state + last few log lines
#   npm run training logs      — tail the live log
#   npm run training restart   — stop then start

COMMAND="${1:-status}"
PIDFILE="$HOME/.hiinakas-training.pid"
LOGFILE="$HOME/.hiinakas-training.log"
PROJECTDIR="$(cd "$(dirname "$0")/.." && pwd)"

is_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "$COMMAND" in

  start)
    if is_running; then
      echo "Already running (PID $(cat "$PIDFILE"))"
      echo "Use 'npm run training logs' to follow progress."
      exit 0
    fi
    mkdir -p "$PROJECTDIR/data" "$PROJECTDIR/models"
    # caffeinate -s  prevents system sleep (works when plugged in)
    # caffeinate -i  prevents idle sleep
    # nohup          keeps the process alive after terminal closes
    cd "$PROJECTDIR"
    nohup caffeinate -s -i bash scripts/run_training.sh \
      > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "Training started (PID $!)."
    echo ""
    echo "  Logs:    tail -f $LOGFILE"
    echo "           or: npm run training logs"
    echo "  Stop:    npm run training stop"
    echo "  Status:  npm run training status"
    echo ""
    echo "NOTE: Keep the Mac plugged in. caffeinate prevents sleep while"
    echo "charging, but a fully closed lid on battery may still sleep."
    ;;

  stop)
    if is_running; then
      PID=$(cat "$PIDFILE")
      # Kill the whole process group so child processes (node, python) also stop.
      kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null
      rm -f "$PIDFILE"
      echo "Stopped (PID $PID)."
    else
      rm -f "$PIDFILE"
      echo "Not running."
    fi
    ;;

  restart)
    bash "$0" stop
    sleep 1
    bash "$0" start
    ;;

  status)
    if is_running; then
      PID=$(cat "$PIDFILE")
      echo "Running (PID $PID)"
      echo ""
      if [[ -f "$LOGFILE" ]]; then
        echo "--- last 10 lines of log ---"
        tail -10 "$LOGFILE"
      fi
    else
      echo "Not running."
      if [[ -f "$LOGFILE" ]]; then
        echo ""
        echo "--- last 5 lines of previous run ---"
        tail -5 "$LOGFILE"
      fi
    fi
    ;;

  logs)
    if [[ -f "$LOGFILE" ]]; then
      tail -f "$LOGFILE"
    else
      echo "No log file yet. Run 'npm run training start' first."
    fi
    ;;

  *)
    echo "Usage: npm run training {start|stop|status|logs|restart}"
    exit 1
    ;;

esac
