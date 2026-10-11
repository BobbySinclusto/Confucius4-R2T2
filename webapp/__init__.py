"""Web surface for Confucius4-R2T2: transcript store, HTTP routes, ASR tap.

Import-light by design — ``ws_server.py`` imports this at module scope, so a
failure here must degrade to "pure ASR websocket server" rather than taking
the vendor server down with it.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from . import transcript_store
from .routes import register_web_routes

__all__ = ["transcript_store", "register_web_routes", "wrap_asr_socket"]

_log = logging.getLogger("r2t2.web")


def wrap_asr_socket(ws: Any, header: Optional[Dict[str, Any]] = None) -> None:
    """Teach one ASR connection to publish its own traffic to the store.

    The vendor handler talks to the client through ``ws.send`` at four different
    places in ``asr_stream_api_v1`` (chunk deltas, VAD-segment end, hallucination
    reset, EOS). Wrapping ``send`` once instead of editing each site keeps the
    diff against upstream to a single line and cannot silently miss a path if
    upstream gains a new one. ``sanic.Websocket`` has no ``__slots__``, so the
    attribute assignment is legal.

    Bookkeeping failures are swallowed: a broken transcript store must never
    stop audio transcription.
    """

    original_send = getattr(ws, "send", None)
    if original_send is None or getattr(ws, "_r2t2_tapped", False):
        return
    header = header or {}

    def observe(message: Any) -> None:
        if not isinstance(message, str):
            return
        parsed = json.loads(message)
        if not isinstance(parsed, dict):
            return
        status = parsed.get("status")
        request_id = parsed.get("requestId")
        if status == "connected" and request_id:
            # A new ASR session means a new transcript document: /transcript.txt
            # goes blank here, which is the "clean slate" the UI promises.
            transcript_store.start(
                request_id,
                language=str(header.get("language") or ""),
                mode=str(header.get("mode") or ""),
            )
        elif status == "success" and request_id:
            transcript_store.record(request_id, parsed.get("msg"))

    async def send(message: Any) -> Any:
        try:
            observe(message)
        except Exception as exc:  # noqa: BLE001 - bookkeeping must never break ASR
            _log.debug("transcript tap ignored a message: %s", exc)
        return await original_send(message)

    ws.send = send
    ws._r2t2_tapped = True
