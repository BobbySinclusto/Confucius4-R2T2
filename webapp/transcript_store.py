"""In-process transcript state for the Confucius4-R2T2 web server.

Sanic runs ``ws_server.py`` with ``single_process=True`` (and the vLLM engine
cannot be forked anyway), so a module-level store is correct here — there is
no second worker process to synchronize with.

The store is intentionally boring: mutation happens synchronously on the event
loop between awaits, so no locks are needed. Watchers poll :func:`snapshot`
(the SSE endpoint) rather than being pushed to, which keeps a dead browser tab
from ever blocking the ASR path.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# How many finished sessions to keep around so "download the last transcript"
# still works right after a restart of transcription.
KEEP_SESSIONS = int(os.environ.get("ASR_TRANSCRIPT_KEEP", "3"))

# If the ASR websocket has produced nothing for this long, /health reports
# not-ready so an external supervisor can restart a wedged container.
# Disabled with 0.
STALE_AFTER_S = float(os.environ.get("ASR_STALE_AFTER_SECONDS", "0"))


@dataclass
class Session:
    """One run of transcription, from Start in the browser to disconnect.

    ``rev`` counts appended deltas, which is all the SSE watchers need to know
    to ship only the tail they have not seen yet.
    """

    session_id: str
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    connected: bool = False
    language: str = ""
    mode: str = ""
    text: str = ""
    rev: int = 0

    # Byte offset already handed to watchers, per revision.
    def tail_from(self, offset: int) -> str:
        return self.text[offset:]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "connected": self.connected,
            "language": self.language,
            "mode": self.mode,
            "chars": len(self.text),
            "words": len(self.text.split()),
            "seconds_since_update": round(time.time() - self.updated_at, 1),
            "rev": self.rev,
        }


# Module state: the session being transcribed right now, plus the recent history.
_current: Optional[Session] = None
_previous: List[Session] = []
_last_progress: float = 0.0


def start(session_id: str, language: str = "", mode: str = "") -> Session:
    """Begin a new session, retiring whatever was transcribed before it.

    This is what gives both surfaces their "clean slate" behaviour: a fresh
    browser Start mints a new ``requestId``, and the moment it shows up here
    ``/transcript.txt`` starts returning an empty document again.
    """
    global _current, _last_progress
    if _current is not None and _current.session_id == session_id:
        # The browser reuses one requestId across reconnect attempts, so this is
        # a resumed stream, not a new session: keep the words we already have.
        _current.connected = True
        _current.updated_at = time.time()
        _last_progress = _current.updated_at
        return _current
    if _current is not None:
        _previous.append(_current)
        del _previous[:-max(KEEP_SESSIONS - 1, 1)]
    _current = Session(session_id=session_id, language=language, mode=mode, connected=True)
    _last_progress = time.time()
    return _current


def record(session_id: str, out_msg: Any) -> None:
    """Append one ASR message's text to the session.

    ``out_msg`` is the server's inner ``msg`` dict. ``reset`` is *not* treated
    as "throw the text away": in every code path that emits it
    (``ws_server.py`` VAD-segment end, hallucination reset, EOS) the accompanying
    ``text`` is still the incremental tail, so appending keeps us in step with
    what the browser shows.
    """
    global _current, _last_progress
    if not isinstance(out_msg, dict):
        return
    text = out_msg.get("text") or ""
    _last_progress = time.time()
    if not text:
        if _current is not None:
            _current.updated_at = _last_progress
        return
    if _current is None or _current.session_id != session_id:
        # ASR produced text for a session we never saw start (e.g. the server
        # was restarted mid-stream). Adopt it rather than dropping the words.
        if _current is not None:
            _previous.append(_current)
        _current = Session(session_id=session_id or "unknown", connected=True)
    _current.text += text
    _current.rev += 1
    _current.updated_at = _last_progress


def finish(session_id: str | None = None) -> None:
    global _current
    if _current is not None and (session_id is None or _current.session_id == session_id):
        _current.connected = False
        _current.updated_at = time.time()


def current() -> Optional[Session]:
    return _current


def render() -> str:
    """Plain running text of the live session (D8: no JSON, no timestamps)."""
    return _current.text if _current is not None else ""


def snapshot() -> Dict[str, Any]:
    return {
        "current": _current.snapshot() if _current is not None else None,
        "previous": [s.snapshot() for s in _previous[-(KEEP_SESSIONS - 1):]] if KEEP_SESSIONS > 1 else [],
        "idle_seconds": round(time.time() - _last_progress, 1) if _last_progress else None,
    }


def stale() -> bool:
    """True when inference made no progress for STALE_AFTER_S while connected."""
    if STALE_AFTER_S <= 0 or _current is None or not _current.connected:
        return False
    return (time.time() - _last_progress) > STALE_AFTER_S
