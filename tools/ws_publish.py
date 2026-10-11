#!/usr/bin/env python3
"""Browser-equivalent publisher: streams a WAV file at the ASR websocket and
prints the live transcript, exactly as the web page does.

Use it to verify the server end to end without a browser, and (with
``--duration``) to run long streams.

    python tools/ws_publish.py --uri ws://localhost:8272/asr_stream_api_v1 \
        --audio resources/test.wav

    # two hours of audio at 4x realtime, for endurance runs
    python tools/ws_publish.py --audio talk.wav --duration 2h --speed 4 --quiet

Audio is converted to 16 kHz mono s16le with ffmpeg when needed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path

try:  # websockets >= 14
    from websockets.asyncio.client import connect
except ImportError:  # pragma: no cover - older websockets
    from websockets import connect  # type: ignore

EOS = "YOUDAO_ONETIME_ASR_STREAM_EOS"
SAMPLE_RATE = 16000
FRAME_MS = 160
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000


def load_pcm16(path: Path) -> bytes:
    """Return 16 kHz mono s16le samples for any media file."""
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as wf:
            if wf.getframerate() == SAMPLE_RATE and wf.getnchannels() == 1 and wf.getsampwidth() == 2:
                return wf.readframes(wf.getnframes())
    if shutil.which("ffmpeg") is None:
        raise SystemExit(f"ffmpeg is required to convert {path} to 16 kHz mono")
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg failed on {path}: {proc.stderr.decode(errors='replace')[:400]}")
    return proc.stdout


def parse_duration(text: str | None) -> float | None:
    if not text:
        return None
    text = text.strip().lower()
    mult = {"ms": 1e-3, "s": 1.0, "m": 60.0, "h": 3600.0}
    for suffix, factor in mult.items():
        if text.endswith(suffix):
            return float(text[: -len(suffix)]) * factor
    return float(text)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(len(ordered) * pct / 100))
    return ordered[idx]


async def run(args) -> int:
    pcm = load_pcm16(Path(args.audio))
    total_seconds = len(pcm) / 2 / SAMPLE_RATE
    loop_for = parse_duration(args.duration)
    if loop_for is None:
        loop_for = total_seconds
    if total_seconds <= 0:
        raise SystemExit(f"{args.audio} produced no audio")

    request_id = str(uuid.uuid4())
    header = {
        "channels": 1,
        "sample_rate": SAMPLE_RATE,
        "requestId": request_id,
        "language": args.language,
        "use_vad": args.use_vad,
        "secret_key": args.secret_key,
        "mode": args.mode,
    }

    uri = args.uri
    print(f"connecting {uri}  requestId={request_id}", flush=True)
    text_parts: list[str] = []
    latencies: list[float] = []
    sent_frames = 0
    got_connected = False
    delta_count = 0
    started = time.time()
    stop_at = started + loop_for

    async with connect(uri, ping_interval=None, max_size=None) as ws:
        await ws.send(json.dumps(header))
        try:
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            got_connected = ack.get("status") == "connected"
            if not got_connected:
                print(f"unexpected first message: {ack}", flush=True)
        except asyncio.TimeoutError:
            print("no ack within 30 s", flush=True)

        async def receiver() -> None:
            nonlocal delta_count
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=args.recv_timeout)
                except asyncio.TimeoutError:
                    print("receiver: timeout waiting for server", flush=True)
                    return
                except Exception as exc:  # noqa: BLE001
                    print(f"receiver: connection closed: {exc!r}", flush=True)
                    return
                if not isinstance(raw, str):
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict) or "status" not in msg:
                    continue  # bare {} keep-alives
                if msg.get("status") != "success":
                    print(f"server: {msg}", flush=True)
                    continue
                inner = msg.get("msg") or {}
                piece = inner.get("text") or ""
                if piece:
                    text_parts.append(piece)
                    delta_count += 1
                    if not args.quiet:
                        print(piece, end="", flush=True)
                reported_lag = inner.get("lag_ms")
                if isinstance(reported_lag, (int, float)):
                    latencies.append(float(reported_lag))
                if args.verbose and inner:
                    print(
                        f"\n[asr_cost_ms={inner.get('asr_cost_ms')} lag_ms={inner.get('lag_ms')}]",
                        end="",
                        flush=True,
                    )

        recv_task = asyncio.create_task(receiver())

        offset = 0
        next_send = time.monotonic()
        try:
            while time.time() < stop_at:
                if offset + FRAME_SAMPLES * 2 > len(pcm):
                    offset = 0  # loop the file for long runs
                frame = pcm[offset : offset + FRAME_SAMPLES * 2]
                offset += len(frame)
                if len(frame) < FRAME_SAMPLES * 2:
                    continue
                await ws.send(frame)
                sent_frames += 1
                next_send += (FRAME_MS / 1000.0) / args.speed
                delay = next_send - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                if args.stats_every and sent_frames % args.stats_every == 0:
                    elapsed = time.time() - started
                    print(
                        f"\n[{elapsed:6.1f}s] frames={sent_frames} deltas={delta_count} "
                        f"chars={sum(len(p) for p in text_parts)}",
                        flush=True,
                    )
        except Exception as exc:  # noqa: BLE001
            print(f"\nsender failed after {sent_frames} frames: {exc!r}", flush=True)

        try:
            await ws.send(EOS)
        except Exception:
            pass
        try:
            await asyncio.wait_for(recv_task, timeout=10)
        except asyncio.TimeoutError:
            recv_task.cancel()

    transcript = "".join(text_parts)
    elapsed = time.time() - started
    print("\n" + "=" * 72)
    print(f"connected={got_connected} frames={sent_frames} deltas={delta_count} elapsed={elapsed:.1f}s")
    print(f"audio_seconds={loop_for:.1f} chars={len(transcript)}")
    if latencies:
        print(f"delta latency p50={percentile(latencies, 50):.0f} ms p95={percentile(latencies, 95):.0f} ms")
    print("-" * 72)
    print(transcript if args.quiet else transcript)
    print("=" * 72)
    return 0 if transcript.strip() else 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uri", default="ws://localhost:8272/asr_stream_api_v1")
    ap.add_argument("--audio", default="resources/test.wav")
    ap.add_argument("--language", default="English")
    ap.add_argument("--mode", default="slow", help="server header 'mode'; anything but 'slow' enables rollback_punctuation")
    ap.add_argument("--secret-key", default="test0102")
    ap.add_argument("--use-vad", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0, help="1.0 = realtime, 4 = four times as fast")
    ap.add_argument("--duration", default=None, help="how much audio-time to stream, e.g. 30m, 2h (default: one file)")
    ap.add_argument("--recv-timeout", type=float, default=120.0)
    ap.add_argument("--stats-every", type=int, default=0, help="print a progress line every N frames")
    ap.add_argument("--quiet", action="store_true", help="do not stream deltas to stdout")
    ap.add_argument("--verbose", action="store_true", help="show per-chunk cost/lag annotations")
    args = ap.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
