# Plan — Real-time transcription website on Confucius4-R2T2

Status: **approved — implementation in progress**. Decisions recorded in §4, questions resolved in §8.

**Primary requirement (re-prioritized by you): run unattended for 30+ minutes, ideally unbounded.**
The old WhisperLiveKit implementation in the parent repo died after a couple of minutes; Confucius is
untested on this machine. Everything below is ordered so that long-run stability is measured before the
UI is considered done. Note the failure you saw was in WhisperLiveKit, not this code path — this server
has a bounded 16 s audio window (`r2t2_asr.py:655-675`), so the classic "context grows until it dies"
failure should not apply, but vLLM-side accumulation over ~11,000 `generate()` calls per hour is unproven
and is the main thing I will measure (§4.5).

---

## 0. Answer first: what weights to download

**Please download these two things** (≈ 4.1 GB total). Everything else I can do without you.

| What | Where it goes | Size | Needed for |
|---|---|---|---|
| `netease-youdao/Confucius4-R2T2` (HF safetensors, bf16) | `checkpoints/Confucius4-R2T2/` | **4.09 GB** (`model.safetensors` 4.08 GB + tokenizer/processor JSONs) | The upstream vLLM streaming server (`ws_server.py`) and the streaming state machine in `r2t2/r2t2_asr.py` |
| `FireRedTeam/FireRedVAD` → `Stream-VAD/*` only | `checkpoints/vad/Stream-VAD/` | **~2.4 MB** | `ws_server.py` calls `stream_vad.detect_chunk()` unconditionally (`if True or use_vad:` at `ws_server.py:1074`), so the server will not start without it |

```bash
cd /home/allen/OpenLiveTranslate/new_stuff/transcription/Confucius4-R2T2

# 1) HF checkpoint (4.1 GB) — keep the folder name so --model_path is a plain dir
hf download netease-youdao/Confucius4-R2T2 --local-dir checkpoints/Confucius4-R2T2

# 2) Streaming VAD (2.4 MB) — lands at checkpoints/vad/Stream-VAD, the server default
hf download FireRedTeam/FireRedVAD --include "Stream-VAD/*" --local-dir checkpoints/vad
```

(If `hf` is missing: `pip install -U "huggingface_hub[cli]"`, or `modelscope download` if HF is slow from here.)

### Why the HF checkpoint and not the GGUFs you already have

| | vLLM + HF checkpoint (**proposed**) | llama.cpp + GGUF (what's on disk now) |
|---|---|---|
| Server implementation | `ws_server.py` — vendor-written, tuned, documented, streaming-aware | **none exists**; I would write a new websocket server around `r2t2_llama` from scratch |
| Streaming API | `init_streaming_state` / `streaming_transcribe_no_reset` / `finish_streaming_transcribe_no_reset` (`r2t2_asr.py:267+` asserts `backend == 'vllm'`) | `r2t2_llama/model.py` has its own streaming wrapper, untested against a server |
| Runtime | Already available locally: `qwenllm/qwen3-asr:latest` has Python 3.10, torch 2.9.1, **vllm 0.14.0**, `qwen-asr 0.0.4` (which registers `Qwen3ASRForConditionalGeneration` in vLLM's model registry — verified) | `r2t2_llama/native/qwen3asr_native.cpython-312-*.so` is **CPython 3.12 only** → the ready-made image is 3.10, so I'd need a new cp312 + CUDA + torch image (~10 GB of pulls) |
| Robustness | Reference route | `r2t2_llama/README.md` says the llama encoder is weaker on quiet onsets; `stream_llama_hybrid` (recommended mode) *still needs the HF dir* for `Qwen3ASRProcessor` |

Net: GGUF-only would mean **more work, more disk, and no vendor server**. The GGUFs stay useful as a later optimization (a `stream_llama` decode backend would cut VRAM/latency), and I've kept the design backend-agnostic in §5 so we can swap it without touching the frontend.

⚠️ **Disk**: `/` is at **97 % — only 15 GB free**. 4.1 GB of weights + a thin image layer (~100 MB) fits, but it leaves little headroom. I will not pull additional multi-GB base images. If the download would push us under ~8 GB free, tell me and I'll prune Docker build cache first (`docker system df`).

---

## 1. What we're building (from `AGENTS.md`)

One server, two surfaces:

1. **`GET /`** — interactive mobile page: start/stop button + live transcript. Starting clears the previous session.
2. **`GET /transcript.txt`** — plain-text endpoint with the current transcript since the last restart of transcription.

Backend = the existing `ws_server.py` websocket ASR server, running in Docker with GPU.

---

## 2. Current state (verified on this machine)

* `ws_server.py` (1281 lines, Sanic, `single_process=True`) exposes `/asr_stream_api_v0` and `/asr_stream_api_v1`. **v1 is the supported one** (README documents only v1).
* Protocol (verified in code + README):
  * Client → server: 1 JSON header first (`requestId`, `channels`, `sample_rate`, `language`, `use_vad`, `secret_key`, `mode`, `smooth`), then raw **16 kHz mono little-endian int16 PCM** binary frames (reference: 160 ms = 2560 samples = 5120 B), then the literal string `YOUDAO_ONETIME_ASR_STREAM_EOS`.
  * Server → client: JSON `{"status":"success","requestId":...,"msg":{"text":<incremental>,"reset":bool,"asr_cost_ms":...,"total_cost_ms":...,"lag_ms":...}}`; also bare `{}` keep-alives that must be ignored; `{"status":"connected"}` ack; `{"status":"error", ...}`.
  * `text` is **incremental** — the client concatenates. `reset:true` appears at VAD-segment end, hallucination reset, and EOS.
* **Auth**: header `secret_key` must be in `secret_key_list` — currently hard-coded `["test0102"]` (`ws_server.py:391`).
* **Server has no HTTP routes at all** (websocket only) and no transcript store → both need adding.
* `checkpoints/` is git-ignored (good: weights never get committed) and currently holds only the two GGUFs.
* The last launch attempt failed: `nohup_service_ws_localhost_8272.log` → `ModuleNotFoundError: No module named 'sanic'` (host Python 3.14, no deps). **Host is not a viable runtime; Docker is the path.**
* `qwenllm/qwen3-asr:latest` verified working with GPU passthrough (`docker run --gpus all … nvidia-smi` → RTX 3070 Laptop, 8192 MiB).
* Missing pip deps for the server: `sanic`, `fireredvad` (0.0.2, pure-python wheel, needs `kaldiio`, `kaldi-native-fbank`, `textgrid` — all light), plus `librosa`/`soundfile`/`sox` which are already in the image.
* Parent repo `~/OpenLiveTranslate` has prior conventions I'll reuse: `docker-compose.yml` (GPU reservations, bind-mount `./new_stuff/<x>:/work`, `HF_HUB_OFFLINE=1`), self-signed `cert.pem`/`key.pem` + `nginx.conf` with websocket upgrade + SSE-friendly `proxy_buffering off`.

---

## 3. Big-picture architecture

```
 iPhone / Android browser                 Docker container (RTX 3070, 8 GB)
┌────────────────────────────┐         ┌───────────────────────────────────────┐
│ /  (index.html + app.js)   │  HTTPS  │ nginx :1443 (self-signed, ws upgrade) │
│  getUserMedia              │────────▶│        │                              │
│   └─ AudioWorklet          │         │        ▼                              │
│       resample → PCM16k    │   ws    │ Sanic :8272  ws_server.py             │
│       160 ms frames  ──────┼────────▶│  ├─ /asr_stream_api_v1  (ASR stream)  │
│                            │◀────────┤  │    └─ deltas → TranscriptStore     │
│  live DOM append, autoscroll│  JSON  │  ├─ GET /            → static/index   │
│  GET /transcript.txt (poll) │        │  ├─ GET /transcript.txt → text/plain  │
└────────────────────────────┘         │  ├─ GET /api/status  → status JSON   │
                                       │  └─ R2T2ASRModel.LLM (vLLM, 0.16 s chunk)│
                                       └───────────────────────────────────────┘
```

One process, one port (Sanic serves both HTTP pages and the websocket; `single_process=True` is already set, so a module-level transcript store is safe — no cross-worker state problem).

---

## 4. Design decisions (confirmed by you on 2026-10-10)

| # | Decision | Proposal | Alternative |
|---|---|---|---|
| D1 | ASR backend | vLLM via HF checkpoint (see §0) ✅ | GGUF/llama.cpp (needs new server + new image) |
| D2 | Where the frontend lives | `web/` inside this repo; Sanic serves it via a **small additive patch** to `ws_server.py` (~25 lines, vendor logic untouched) | Separate proxy process (extra hop, latency, state sync) |
| D3 | Authoritative transcript | Server-side `TranscriptStore` (session id, text, ts, connection flag) written at each ASR delta; `/transcript.txt` renders it | Browser POSTs its concatenated text back (loses truth if browser dies mid-talk) |
| D4 | Session semantics | Browser mints `requestId = crypto.randomUUID()` on every **Start** → new session ⇒ `/transcript.txt` restarts, and the UI clears. Matches "clear whatever text was in the previous session". | Reuse one session, add explicit reset endpoint |
| D5 | TLS | Reuse parent `cert.pem`/`key.pem` through an nginx service in `docker-compose.yml` (mic capture **requires** a secure context; `ws://` on LAN IP will be blocked by iOS/Android). Pattern already exists in `~/OpenLiveTranslate/nginx.conf`. | Sanic native SSL (`--ssl`), or localhost-only dev |
| D6 | Language | **English only**, hard default (`language: "English"` in the WS header). No language dropdown in the UI; `?lang=` stays as an undocumented escape hatch for debugging | — |
| D7 | Auth | Move `secret_key_list` to env `ASR_SECRET_KEYS` (default keeps `test0102`), serve the browser key from `/api/config` | — |
| D8 | `/transcript.txt` body | **Plain running text only** — you will update downstream parsing as needed, so no JSON, no timestamps, no per-segment structure required. UTF-8, spaces/newlines as the model emits them | — |
| D9 | Multi-device | One device publishes (the one with the mic). Any number of additional tabs/devices may **watch** the live session read-only via SSE. A second *publisher* is rejected with a clear message rather than corrupting state | — |

### 4.5 Stability requirements (the point of this project)

Unattended 30-minute sessions with no manual restart. Concretely, I am treating these as the acceptance bar:

| # | Requirement | How it gets proven |
|---|---|---|
| S1 | No unbounded growth (RSS, GPU mem, latency) over ≥ 60 min of continuous audio | Soak harness `tools/soak.py` streams looped audio; samples `ps`/`nvidia-smi`/`/api/status` every 10 s; assert p95 `lag_ms` at minute 60 ≤ p95 at minute 5 × 1.25, and RSS/GPU growth < 5 % |
| S2 | Accelerated soak: 2 h of audio replayed at ~4× rate, zero exceptions in the server log | Same harness with `--speed 4` |
| S3 | A dropped browser connection or browser reload must not take the server with it, and the browser recovers by itself | Kill/reload mid-stream in headless Chromium; expect auto-reconnect ≤ 3 s and the page usable again without a server restart |
| S4 | If the model process ever wedges, the service self-heals | Container `restart: unless-stopped` + `/health` liveness check (fails if no inference progress in N s) + a supervisor loop; page shows a visible "reconnecting" state instead of silently going dead |
| S5 | vLLM multimodal cache cannot grow without bound | Pass `mm_processor_cache_gb=0` (vLLM 0.14, flag verified present in the image) — with a fresh 16 s audio window per chunk the cache only ever thrashes; measured both ways in M1 |
| S6 | No disk creep: `logs/requests/*.log` and `wav_tmp_store/` must not fill the 12 GB of free space | Per-request logs capped/rotated; audio saving stays off by default |

The most likely real failure modes, in the order I will investigate them:
1. **Per-chunk cost exceeding 160 ms** on an 8 GB RTX 3070 → lag grows until the socket times out (`RECV_TIMEOUT = 120 s` closes the connection — this presents exactly as "works for a few minutes then dies"). Mitigation: `mode: fast`, tune `max_new_tokens`, and if needed raise `RECV_TIMEOUT`.
2. vLLM KV / mm-processor cache pressure over thousands of generate calls (S5).
3. Per-connection objects never released when a browser tab vanishes without a clean close.
4. Sanic's single-process event loop being blocked by sync inference while a client disconnects mid-`send`.

---

## 5. Work breakdown

### M0 — Weights + environment (needs you: the two downloads in §0)
- [ ] You run the two `hf download` commands.
- [ ] `Dockerfile.web` — `FROM qwenllm/qwen3-asr:latest`, `pip install sanic==25.* fireredvad==0.0.2`, non-root-able, `WORKDIR /work`, `ENTRYPOINT ["python","-u","ws_server.py"]`. No compile step; base already has every heavy dep.
- [ ] `docker-compose.yml` (new, repo-local; do **not** touch the parent compose) — service `r2t2-web`: `--gpus all`, `--shm-size=4gb`, `--ipc=host`, ports `8272:8272`, bind-mount repo → `/work`, `checkpoints` → `/work/checkpoints`, env `ASR_MODEL_PATH=/work/checkpoints/Confucius4-R2T2`, `VAD_MODEL_PATH=/work/checkpoints/vad/Stream-VAD`, `HF_HUB_OFFLINE=1`.
- [ ] `run_web.sh start|stop|restart|logs|build` thin wrapper (mirrors `run_start_server.sh` style, keeps the repo's convention).
- **Accept:** `docker compose up` boots, logs show `✅ VAD model initialized`, `✅ ASR model initialized`, `✅ ASR model warmup complete`, and `curl localhost:8272/health` → 200.
- **Known risk:** `ws_server.py:286` hard-codes `gpu_memory_utilization=0.95` → 7.6 GB on an 8 GB card, plus vLLM CUDA graphs + KV cache. I'll expose `ASR_GPU_MEM_UTIL` (default **0.55**) and `ASR_ENFORCE_EAGER` (default **on** for 8 GB): verified that `R2T2ASRModel.LLM` inherits `Qwen3ASRModel.LLM`, whose `**kwargs` go straight to `vllm.LLM(model=..., **kwargs)`, so both knobs pass through unchanged.

### M1 — Prove the ASR path end-to-end (the "get the demo working first" step in `AGENTS.md`)
- [ ] `python example.py --audio resources/test.wav --model_path … --infer_mode stream_vllm` inside the container → non-empty transcript.
- [ ] `python ws_client.py` against the running server → incremental text printed.
- [ ] Capture baseline numbers: model load time, warmup time, per-chunk `asr_cost_ms`/`lag_ms`, VRAM used (`nvidia-smi`).
- **Accept:** `resources/test.wav` transcribes correctly through the websocket with `lag_ms` < ~1000 ms and no OOM.
- **Commit checkpoint.**

### M2 — Frontend against a mock (no GPU needed, fully parallelizable with M1)
Files: `web/index.html`, `web/app.js`, `web/recorder.js` (AudioWorklet), `web/style.css`, `web/mock_server.py` (talks the v1 protocol, echoes canned text).
- **Audio capture**: `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})` → `AudioContext` → `AudioWorklet` → downsample to **16 kHz mono** (linear interpolation from 44.1/48 kHz) → `Int16Array` → ring-pack into **2560-sample** frames → `ws.send(frame.buffer)` every 160 ms. (Worklet, not `ScriptProcessorNode`, which is deprecated and glitchy on iOS.)
- **Protocol client**: send header JSON → wait `status:"connected"` → stream → on Stop send `YOUDAO_ONETIME_ASR_STREAM_EOS` → close. Ignore messages without `status` (the bare `{}` keep-alives), ignore non-`success`, and handle close codes 4401 (bad key) / 1011 (model not ready) with readable errors.
- **UI**: large circular start/stop; status pill `idle → connecting → live → stopped/error`; transcript pane with `text` deltas appended, auto-scroll with "pinned to bottom" detection; `lag_ms` read-out; Copy / Download `.txt` / Clear; `navigator.wakeLock` while live; responsive for phones; session id shown.
- **Behaviour on Start**: clear the DOM pane, drop the old session id, mint a new UUID (⇒ D4 clean slate).
- **Reconnect policy**: one automatic retry on unexpected close mid-session, then surface the error (a 30-minute talk must not silently stop transcribing).
- **Accept:** with `mock_server.py` running, start/stop works twice in a row, deltas render, no console errors, and iOS Safari + Chrome both show mic permission prompt over HTTPS.

### M3 — Server additions (patch `ws_server.py`, additive only)
New package `webapp/`:
- `transcript_store.py` — module-level `CURRENT: {session_id, text, started_at, updated_at, connected, lang, mode}` with `start(session_id)`, `append(session_id, delta)`, `finish(session_id)`, `render() -> str`, `snapshot() -> dict`. Plain dict + `asyncio.Lock`; keeps the current session and the previous one (for "download last transcript" after a restart).
- `routes.py` — `register_web_routes(app)` adding:
  - `GET /` → `web/index.html` (+ static assets under `/static/*`)
  - `GET /transcript.txt` → `text/plain; charset=utf-8`, `Cache-Control: no-store`, current session text
  - `GET /api/status` → JSON snapshot (`session_id`, `chars`, `updated_at`, `connected`, `active_connections`)
  - `GET /api/config` → `{ ws_path, language, mode, secret_key, vad }` for the frontend
  - `GET /health` → `{"ok":true,"model_ready":asr_model is not None}`
- `ws_server.py` diff (small, guarded, easy to revert):
  1. `from webapp import transcript_store, register_web_routes` + `register_web_routes(app)` next to the app definition.
  2. `secret_key_list = os.environ.get("ASR_SECRET_KEYS", "test0102").split(",")`.
  3. In the v1 processor: `transcript_store.start(requestId)` right after the `connected` ack; `transcript_store.append(requestId, out_msg["text"])` at the two delta send sites (`ws_server.py:~1130` chunk path, `~995` EOS path, `~1215` hallucination-reset path); `transcript_store.finish(requestId)` in the `finally` block.
  4. `gpu_memory_utilization=float(os.environ.get("ASR_GPU_MEM_UTIL","0.55"))` + `enforce_eager` from env (both forwarded to `vllm.LLM` by the inherited `LLM()` factory).
- **Edge case to verify, not guess:** on a *hallucination reset* the server sets `last_fixed_asr_text=""` and `total_text=""` while the client is told only `{text:<delta>,reset:true}` — naive concatenation keeps the hallucination. During M3 I'll test this and, if confirmed, have `TranscriptStore` honour `reset:true` by truncating to the server-side authoritative text instead of appending (frontend keeps appending, matching the documented client). I will report the observed behaviour rather than silently changing semantics.
- **Accept:** stream through `ws_client.py`, then `curl localhost:8272/transcript.txt` returns the same text the client printed; `/api/status` shows `connected:false` after disconnect; starting a new session clears it.

### M4 — TLS + mobile access
- [ ] `docker-compose.override`/service for `nginx:latest` mounting `../cert.pem`, `../key.pem` and a repo-local `deploy/nginx.conf` (listen 1443 ssl; `/` → `r2t2-web:8272` with `proxy_http_version 1.1` + `Upgrade`/`Connection` headers; `proxy_read_timeout 3600`; `proxy_buffering off`) — copied from the working pattern in the parent repo.
- [ ] Frontend derives WS URL from `location` (`https → wss`), so it works behind nginx and on plain `localhost` in dev.
- [ ] Document how to find the LAN URL, and that iOS needs the self-signed cert accepted once (Safari → `https://<ip>:1443` → "Show Details" → Continue).
- **Accept:** from a real phone on the same Wi-Fi, mic works, text streams, screen stays awake, 30-minute soak with no dropped WS (Sanic ping/pong is disabled server-side, so the client sends a tiny ping frame/tick or relies on audio traffic — I'll verify which keeps nginx alive over an idle mic).

### M5 — Hardening, latency, docs
- [ ] Perf pass: tune `ASR_GPU_MEM_UTIL`, `mode` (`fast` → `nmt_fast=True`), `chunk_size_ms`, `max_new_tokens` floor; report `asr_cost_ms`/`lag_ms` distribution.
- [ ] Resilience: if the model process dies, `/health` goes 503 and the page shows "backend unavailable" instead of a spinner; per-request logs already written to `logs/requests/<requestId>.log` — add rotation note.
- [ ] `README_WEB.md`: setup, the two downloads, URLs, env var table, troubleshooting (mic permission, VRAM, iOS cert, `EADDRINUSE` on `HYBRID_MASTER_PORT` if we ever use the hybrid backend).
- [ ] Commit series: `M1 demo verified` → `web: frontend + mock` → `ws_server: serve pages + transcript store` → `deploy: nginx TLS` → `docs`.

### Deliberately out of scope (flag if you want any)
Speaker diarization (explicitly excluded), translation, audio recording/archives, auth beyond the shared key, multi-worker scaling (Sanic runs single-process today; the vLLM engine can't be forked anyway), persistence across restarts.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| vLLM OOM at 8 GB VRAM (`gpu_memory_utilization=0.95` hard-coded) | **High** | Env-tunable util (0.55 default) + `enforce_eager`; measured fallback ladder 0.55 → 0.45; last resort = llama.cpp GGUF route (§0, backend swap in `webapp/backend.py`) |
| **Disk at 97 % / 15 GB free** | **High** | No new base images; weights into `checkpoints/` (ignored by git); `docker builder prune` in the setup script; monitor `df` before `docker build` |
| `getUserMedia` blocked on insecure origin | **High** | nginx TLS (M4); dev-only `localhost` exception noted |
| 16 kHz resample done in JS drifts / underruns when tab is backgrounded | Medium | Worklet + jitter buffer; UI warning "keep this tab in the foreground"; wake lock |
| `fireredvad` CPU/GPU mismatch (`use_gpu=True` in `ws_server.py:267`) | Medium | Env `VAD_USE_GPU`; VAD is 2.4 MB so CPU fallback is cheap |
| VAD always invoked (`if True or use_vad`) — extra per-chunk cost & behaviour you didn't ask for | Medium | Keep as-is in M1 (vendor behaviour), then measure and gate it behind `ASR_VAD_ENABLED` if it hurts latency |
| Hallucination-reset text semantics (§M3) | Medium | Verify empirically; server-side store is authoritative for `/transcript.txt` |
| Single client per connection state; two phones at once | Low | `active_connections` already tracked; expose in `/api/status`; second stream becomes a second session (last-started wins for `/transcript.txt`) — will document or reject with a clear message per your call |

---

## 7. How I'll verify "it works"

1. `run_example.sh resources/test.wav` → transcript contains the expected words. *(ASR sanity)*
2. `ws_client.py` → same text, incremental. *(server protocol)*
3. `curl /transcript.txt` → identical text. *(textfile endpoint)*
4. Browser → mic → live text appears; stop → new start → pane empty and `/transcript.txt` restarted. *(the two AGENTS.md requirements)*
5. Soak: 30 min of continuous audio (looped file played into the browser) → no disconnect, `lag_ms` stays bounded, memory flat.
6. Latency report: end-of-speech → final text, p50/p95.

---

## 8. Answers received (2026-10-10)

1. **Weights** — downloaded ✅ (`checkpoints/Confucius4-R2T2/model.safetensors` 4.08 GB, `checkpoints/vad/Stream-VAD/`).
2. **Language** — English only.
3. **TLS** — reuse the parent repo `cert.pem`/`key.pem`.
4. **`/transcript.txt`** — plain text; downstream parsing will be updated to match (D8).
5. **Multi-device** — watching the same session is a nice-to-have, one publisher at a time (D9).
6. **VRAM** — the TTS/translator services occupy **~2 GB** during the event, leaving ~5.7 GB usable on the 8 GB card. This is the tightest constraint in the project: bf16 weights alone are 4.08 GB, so `gpu_memory_utilization` must land near 0.62–0.68 with `enforce_eager=on` and a small `max_model_len`. If that does not fit alongside TTS, the fallback ladder is fp8 dynamic quantization of the ASR weights, then asking you to stop TTS during talks.

Additional context from you: the "dies after a couple of minutes" symptom was the **WhisperLiveKit** implementation in the parent repo, not Confucius. Treated as motivation, not as a baseline — I will not copy its design, and §4.5 defines what "fixed" means.
