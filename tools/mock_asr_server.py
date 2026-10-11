#!/usr/bin/env python3
"""Mock of ws_server.py's /asr_stream_api_v1 protocol, for frontend work.

Speaks the real protocol (header JSON -> connected ack -> binary PCM16 frames
-> incremental JSON deltas -> EOS) but emits a canned English sentence instead
of running a model, so the browser page can be developed and tested without
the GPU. Also emits the bare ``{}`` keep-alives that the real server sends, so
clients learn to ignore them.

Run (needs the `websockets` package, e.g. /tmp/r2t2tools/bin/python):

    python tools/mock_asr_server.py --port 8273

Then serve the page however you like, e.g.

    python3 -m http.server 8080 --directory web

and open http://localhost:8080/?ws=ws://localhost:8273/asr_stream_api_v1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid

import websockets

EOS = "YOUDAO_ONETIME_ASR_STREAM_EOS"
SAMPLE_RATE = 16000

WORDS = (
    "Good morning everyone and welcome to the session today we are going to walk "
    "through the transcription pipeline and answer questions at the end thanks for being here"
).split()

STATE = {"active": 0, "frames": 0, "sessions": 0}


async def handler(ws, words_per_sec: float, keepalive_every: int, fail_first: int):
    STATE["active"] += 1
    STATE["sessions"] += 1
    request_id = None
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        header = json.loads(raw)
        request_id = header.get("requestId")
        if "requestId" not in header:
            await ws.send(json.dumps({"status": "error", "msg": "json header is expected"}))
            return
        if header.get("secret_key") != "test0102":
            await ws.close(code=4401, reason="Unauthorized")
            return
        await ws.send(
            json.dumps(
                {
                    "status": "connected",
                    "requestId": request_id,
                    "msg": "",
                    "active_connections": STATE["active"],
                }
            )
        )

        word_index = 0
        pending_samples = 0
        started = time.time()
        while True:
            data = await ws.recv()
            if isinstance(data, str):
                if data == EOS:
                    await ws.send(
                        json.dumps(
                            {
                                "status": "success",
                                "requestId": request_id,
                                "msg": {"text": " That concludes the mock transcript.", "reset": True, "asr_cost_ms": 1.0},
                            },
                            ensure_ascii=False,
                        )
                    )
                    await ws.close()
                    return
                continue

            pending_samples += len(data) // 2
            STATE["frames"] += 1
            # Emit roughly words_per_sec worth of words relative to the audio time.
            audio_seconds = pending_samples / SAMPLE_RATE
            elapsed = time.time() - started
            target = int(min(audio_seconds, elapsed + 0.5) * words_per_sec)
            while word_index < target and word_index < fail_first + len(WORDS) * 10_000:
                word = WORDS[word_index % len(WORDS)]
                word_index += 1
                text = ("" if word_index == 1 else " ") + word
                await ws.send(
                    json.dumps(
                        {
                            "status": "success",
                            "requestId": request_id,
                            "msg": {
                                "text": text,
                                "reset": False,
                                "asr_cost_ms": 12.5,
                                "total_cost_ms": 15.0,
                                "lag_ms": round((time.time() - elapsed) * 1000, 1),
                            },
                        },
                        ensure_ascii=False,
                    )
                )
            if keepalive_every and STATE["frames"] % keepalive_every == 0:
                await ws.send("{}")
    except websockets.ConnectionClosed:
        pass
    except Exception as exc:  # noqa: BLE001 - mock should keep serving other clients
        print(f"mock: handler error: {exc!r}")
    finally:
        STATE["active"] -= 1


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8273)
    ap.add_argument("--words-per-sec", type=float, default=2.5)
    ap.add_argument("--keepalive-every", type=int, default=50, help="send a bare {} every N frames (0 disables)")
    ap.add_argument("--fail-first", type=int, default=0)
    args = ap.parse_args()

    async with websockets.serve(
        lambda ws: handler(ws, args.words_per_sec, args.keepalive_every, args.fail_first),
        args.host,
        args.port,
    ):
        print(f"mock ASR server on ws://{args.host}:{args.port}/asr_stream_api_v1 (sessions so far: see logs)")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
