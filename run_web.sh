#!/usr/bin/env bash
# Control the real-time transcription web server.
#
# Usage:
#   ./run_web.sh up            Build if needed, start ASR + web on :8272
#   ./run_web.sh up --tls      Also start nginx TLS on :1443 (required for mic
#                              access from any device that is not this host)
#   ./run_web.sh down          Stop the stack
#   ./run_web.sh restart       down + up, preserving TLS mode
#   ./run_web.sh logs          Follow server logs
#   ./run_web.sh status        Container state + /health + LAN URL
#   ./run_web.sh wait          Block until /health reports ready
#   ./run_web.sh test          End-to-end self test (streams resources/test.wav)
#
# Environment overrides (all optional):
#   ASR_PORT=8272  ASR_TLS_PORT=1443  ASR_GPU_MEM_UTIL=0.62  ASR_LANGUAGE=English
#   ASR_SECRET_KEYS=test0102  VAD_USE_GPU=0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.web.yml"
STATE_FILE=".run_web_tls"
CMD="${1:-}"
SHIFTED=("${@:2}")

# Whether TLS is part of the stack is remembered between invocations, otherwise
# `down` would leave the nginx container orphaned (compose only manages the
# services matching the active profiles).
TLS_PROFILE=""
[[ -f "$STATE_FILE" ]] && TLS_PROFILE="tls"
# Self-heal: adopt a running TLS container even if our state file is stale or
# missing, so `down` cannot leave nginx orphaned.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^r2t2-tls$'; then
    TLS_PROFILE="tls"
    : > "$STATE_FILE"
fi
WANTS_TLS=0
for arg in "${SHIFTED[@]}"; do
    [[ "$arg" == "--tls" ]] && WANTS_TLS=1
done
if [[ "$CMD" == "up" || "$CMD" == "start" || "$CMD" == "restart" ]]; then
    if [[ "$WANTS_TLS" == "1" ]]; then
        TLS_PROFILE="tls"
        touch "$STATE_FILE"
    else
        # An explicit `up` without --tls means "no TLS layer".
        TLS_PROFILE=""
        rm -f "$STATE_FILE"
    fi
fi

compose() {
    if [[ -n "$TLS_PROFILE" ]]; then
        docker compose -f "$COMPOSE_FILE" --profile tls "$@"
    else
        docker compose -f "$COMPOSE_FILE" "$@"
    fi
}

health() {
    curl -fsS --max-time 5 "http://localhost:${ASR_PORT:-8272}/health" 2>/dev/null || true
}

lan_url() {
    local ip
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "http://${ip:-127.0.0.1}:${ASR_PORT:-8272}/"
    echo "https://${ip:-127.0.0.1}:${ASR_TLS_PORT:-1443}/  (TLS, needed for phone microphones)"
    echo "http://localhost:${ASR_PORT:-8272}/transcript.txt  (plain-text endpoint)"
}

cmd="$CMD"

case "$cmd" in
    up|start)
        if [[ ! -d checkpoints/Confucius4-R2T2 ]] || [[ ! -d checkpoints/vad/Stream-VAD ]]; then
            echo "Missing model weights under checkpoints/ — see PLAN.md section 0." >&2
            exit 1
        fi
        if [[ ! -f ../cert.pem || ! -f ../key.pem ]]; then
            echo "Note: parent cert.pem/key.pem not found; --tls will fail." >&2
        fi
        if ! docker image inspect r2t2-web:latest >/dev/null 2>&1; then
            echo "Building r2t2-web:latest ..."
            docker build -f Dockerfile.web -t r2t2-web:latest .
        fi
        echo "tls_profile=$TLS_PROFILE"
        compose up -d
        echo
        echo "Model load + warmup takes a few minutes on this GPU. Following logs:"
        compose logs -f r2t2-web 2>/dev/null | grep -E --line-buffered "initialized|warmup|error|Error|Traceback|Started server|vLLM" &
        LOGPID=$!
        trap 'kill $LOGPID 2>/dev/null || true' EXIT
        ./run_web.sh wait
        kill $LOGPID 2>/dev/null || true
        trap - EXIT
        echo
        echo "Ready:"
        lan_url
        ;;
    down|stop)
        compose down
        ;;
    restart)
        "$0" down
        "$0" up "${SHIFTED[@]}"
        ;;
    logs)
        compose logs -f
        ;;
    wait)
        printf "waiting for /health "
        for _ in $(seq 1 180); do
            body="$(health)"
            if [[ -n "$body" ]] && echo "$body" | grep -q '"ok": *true'; then
                echo " ready"
                echo "$body"
                exit 0
            fi
            printf .
            sleep 5
        done
        echo " timed out"
        echo "Last health response: $(health)"
        exit 1
        ;;
    status)
        compose ps
        echo
        echo "health: $(health)"
        echo
        lan_url
        ;;
    test)
        python3 ws_stream_test.py "${@:2}"
        ;;
    *)
        sed -n '2,22p' "$0"
        exit 1
        ;;
esac
