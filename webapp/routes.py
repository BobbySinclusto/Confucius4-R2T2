"""HTTP surface for the web transcription server.

Everything here is additive to the vendor ``ws_server.py``: the ASR websocket
endpoint is untouched, and these routes are registered on the same Sanic app
(one process, one port, so the transcript store needs no plumbing).

Routes
------
``GET /``               interactive page (mic → ASR websocket → live text)
``GET /static/*``       page assets
``GET /transcript.txt`` plain-text transcript of the current session
``GET /api/status``     JSON snapshot (session, chars, connected, latency-ish)
``GET /api/config``     what the browser needs to open the ASR websocket
``GET /api/stream``     SSE feed so extra tabs/devices can watch passively
``GET /health``         liveness/readiness for a supervisor
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from sanic import Sanic
from sanic.request import Request
from sanic.response import HTTPResponse, ResponseStream, html, json as json_response, raw, text

from . import transcript_store

_log = logging.getLogger("r2t2.web.routes")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

WS_PATH = os.environ.get("ASR_WS_PATH", "/asr_stream_api_v1")
# The browser has to send a key from ws_server.py's secret_key_list. It is
# visible in page source by construction — this is a LAN demo guard, not auth.
BROWSER_SECRET_KEY = os.environ.get("ASR_BROWSER_SECRET_KEY", "test0102")
DEFAULT_LANGUAGE = os.environ.get("ASR_LANGUAGE", "English")
DEFAULT_MODE = os.environ.get("ASR_MODE", "slow")
USE_VAD = os.environ.get("ASR_USE_VAD", "0") == "1"
SSE_INTERVAL = float(os.environ.get("ASR_SSE_INTERVAL", "0.35"))
SSE_MAX_HOURS = float(os.environ.get("ASR_SSE_MAX_HOURS", "12"))


def _text(body: str, status: int = 200) -> HTTPResponse:
    # text()/html() rather than response(...): sanic.response exports the
    # helpers, not a generic `response` callable.
    return text(
        body,
        status=status,
        headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
    )


def register_web_routes(app: Sanic, state_probe: Optional[Callable[[], Dict[str, Any]]] = None) -> None:
    """Attach the web routes.

    ``state_probe`` returns ``{"model_ready": bool, "active_connections": int}``
    read out of ``ws_server``'s globals; it is passed in rather than imported to
    keep this module importable on its own (and importable at all if the model
    failed to load).
    """

    def probe() -> Dict[str, Any]:
        try:
            return (state_probe or (lambda: {}))()
        except Exception as exc:  # never let a status call take the server down
            return {"probe_error": str(exc)}

    @app.get("/")
    async def index(request: Request):
        index_path = WEB_DIR / "index.html"
        if not index_path.exists():
            return _text(f"web/index.html missing (looked in {WEB_DIR})", 500)
        return html(
            index_path.read_text(encoding="utf-8"),
            headers={"Cache-Control": "no-store"},
        )

    # index.html uses relative asset URLs so the same file works when served by
    # the backend at / and by a plain static server during frontend testing.
    # Allowlisted rather than a wildcard, so a typo can never read an arbitrary
    # file off disk.
    @app.get("/<filename:(?:app\\.js|style\\.css|recorder-worklet\\.js|favicon\\.ico)>")
    async def asset(request: Request, filename: str):
        candidate = (WEB_DIR / filename).resolve()
        if WEB_DIR not in candidate.parents or not candidate.is_file():
            return _text("not found", 404)
        kinds = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
        kind = kinds.get(candidate.suffix, "application/octet-stream")
        return raw(candidate.read_bytes(), content_type=kind, headers={"Cache-Control": "no-cache"})

    @app.get("/transcript.txt")
    async def transcript(request: Request):
        # Plain running text only (PLAN.md D8): nothing to parse, nothing to
        # break, safe to poll or curl from a downstream script.
        if request.args.get("json"):
            return json_response({"text": transcript_store.render(), **transcript_store.snapshot()})
        return _text(transcript_store.render())

    @app.get("/api/status")
    async def status(request: Request):
        state = probe()
        return json_response({"ok": True, "model_ready": state.get("model_ready"), "active_connections": state.get("active_connections"), **transcript_store.snapshot()})

    @app.get("/api/config")
    async def config(request: Request):
        return json_response(
            {
                "ws_path": WS_PATH,
                "secret_key": BROWSER_SECRET_KEY,
                "language": DEFAULT_LANGUAGE,
                "mode": DEFAULT_MODE,
                "use_vad": USE_VAD,
                "sample_rate": 16000,
            }
        )

    @app.get("/health")
    async def health(request: Request):
        state = probe()
        model_ready = bool(state.get("model_ready"))
        stale = transcript_store.stale()
        body = {
            "ok": model_ready and not stale,
            "model_ready": model_ready,
            "stale": stale,
            "active_connections": state.get("active_connections"),
            "uptime_seconds": round(time.time() - STARTED_AT, 1),
            "session": transcript_store.current().session_id if transcript_store.current() else None,
        }
        return json_response(body, status=200 if body["ok"] else 503)

    @app.get("/api/stream")
    async def stream(request: Request):
        """Server-sent events: lets extra tabs/devices watch the live session.

        Poll-based on purpose: a watcher that goes away can never stall the
        transcription path, and 0.35 s is far below human perception for a
        caption feed.
        """
        headers = {
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }

        async def pump(resp: ResponseStream) -> None:
            sent_len = 0
            last_rev = -1
            seen_session = None
            deadline = time.time() + SSE_MAX_HOURS * 3600.0
            try:
                # Sanic's stream callback object exposes write()/eof(), not send().
                while time.time() < deadline:
                    session = transcript_store.current()
                    if session is None:
                        if seen_session is not None:
                            sent_len, last_rev, seen_session = 0, -1, None
                    else:
                        if session.session_id != seen_session:
                            # New (or adopted) session: the watcher starts over.
                            sent_len, last_rev, seen_session = 0, -1, session.session_id
                        if session.rev != last_rev:
                            payload = {
                                "event": "delta",
                                "text": session.tail_from(sent_len),
                                **session.snapshot(),
                            }
                            sent_len = len(session.text)
                            last_rev = session.rev
                            await resp.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n")
                    await resp.write(": ping\n\n")
                    await asyncio.sleep(SSE_INTERVAL)
            except (asyncio.CancelledError, ConnectionError, BrokenPipeError) as exc:
                # Client went away mid-write: expected. Logged at debug so a real
                # regression here is not invisible the way it was for the
                # AttributeError this used to swallow.
                _log.debug("SSE stream ended: %s", exc)

        return ResponseStream(pump, headers=headers, content_type="text/event-stream")

    # Mounted at /static so index.html can reference /static/app.js etc.
    # Mounting the whole web dir (rather than a web/static subdir) keeps the
    # frontend's file layout flat.
    if WEB_DIR.is_dir():
        app.static("/static", str(WEB_DIR), name="web_static")


STARTED_AT = time.time()
