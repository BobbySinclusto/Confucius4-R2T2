# Real-time transcription web server

Browser page + plain-text endpoint on top of the Confucius4-R2T2 streaming ASR
websocket server. One container, one GPU, no build step on the client.

```
phone (mic) ──wss──▶ nginx :1443 ──▶ Sanic :8272 ──▶ vLLM (Confucius4-R2T2)
                                        │
                                        ├─ GET /                live page
                                        ├─ GET /transcript.txt  plain text
                                        └─ GET /api/stream      SSE (watchers)
```

## Quick start

```bash
cd /home/allen/OpenLiveTranslate/new_stuff/transcription/Confucius4-R2T2

./run_web.sh up --tls      # builds the image on first run, then loads the model
./run_web.sh status        # container state, /health, URLs
./run_web.sh logs          # follow server logs
./run_web.sh down          # stop
```

Model load + warmup is about **60 s**. `up` blocks until `/health` reports ready
and prints the URLs.

### Then open

| URL | What |
|---|---|
| `https://<this-host-ip>:1443/` | **the page to use from a phone** (TLS — required for microphone access) |
| `http://<this-host-ip>:8272/` | same page on the host network; mic only works on `localhost` |
| `http://<this-host-ip>:8272/transcript.txt` | plain-text transcript of the current session |
| `https://<this-host-ip>:1443/?watch=1` | read-only follower view, no microphone needed |

Self-signed certificate: the first visit from a phone needs the usual
"accept the risk" tap (iOS: Show Details → Visit this Website).

### Using it

1. Open the page, press **Start**, allow the microphone.
2. Speak. Text appears incrementally; the pill shows `Transcribing` and live `lag`.
3. Press **Stop** to end. Pressing Start again always begins a clean transcript
   (the browser view and `/transcript.txt` both reset).
4. `/transcript.txt` is plain running text — poll it, `curl` it, tail it. It
   contains exactly what the page shows, accumulated server-side.

## Configuration (env vars, all optional)

Set them inline (`ASR_GPU_MEM_UTIL=0.7 ./run_web.sh up`) or in the shell.

| Variable | Default | Notes |
|---|---|---|
| `ASR_GPU_MEM_UTIL` | `0.72` | vLLM fraction of the whole card. bf16 weights are 3.8 GiB; below ~0.7 the engine refuses to start with "No available memory for the cache blocks". |
| `ASR_MAX_MODEL_LEN` | `1024` | A streaming prompt is one ~16 s audio window ≈ 200 audio tokens (12.5 tok/s) + a few dozen text tokens. |
| `ASR_MAX_NUM_BATCHED_TOKENS` | `1024` | Caps vLLM's profiling peak, which is what actually frees the KV cache. |
| `ASR_SKIP_MM_PROFILING` | `1` | Don't reserve memory for a worst-case multimodal input we never send. |
| `ASR_ENFORCE_EAGER` | `1` | Skips CUDA graphs (~0.5–1 GiB) in exchange for slightly slower chunks. |
| `ASR_MM_CACHE_GB` | `0` | The sliding 16 s window is never cache-relevant; hashing it costs CPU. |
| `VAD_USE_GPU` | `0` | FireRedVAD is 2.4 MB; CPU is cheaper than another CUDA context. |
| `ASR_LANGUAGE` | `English` | Sent in the page's WS header; also the default for `tools/ws_publish.py`. |
| `ASR_MODE` | `slow` | Vendor header field. Despite the name it maps to `rollback_punctuation` in `r2t2_asr.py`, not to a speed switch. |
| `ASR_SECRET_KEYS` | `test0102` | Keys the ASR websocket accepts (shared secret, not authentication). |
| `ASR_BROWSER_SECRET_KEY` | `test0102` | The key handed to the page by `/api/config`; must appear in `ASR_SECRET_KEYS`. |
| `ASR_STALE_AFTER_SECONDS` | `180` | If inference makes no progress this long while connected, `/health` returns 503 so a supervisor can restart. `0` disables. |
| `ASR_PORT` / `ASR_TLS_PORT` | `8272` / `1443` | Host ports. |

## What was verified (2026-10-10, RTX 3070 Laptop 8 GB)

* `tools/ws_publish.py` (browser-equivalent client) → correct English transcript,
  `asr_cost_ms` ≈ 57–65 ms per 160 ms chunk, `lag_ms` ≈ 60–116 ms.
* Headless Chromium with the microphone wired to `resources/english.wav`
  (`tools/browser_e2e.js`) → mic → AudioWorklet resampler → WebSocket → model →
  text in the DOM, **over HTTPS/wss through nginx**, no console errors.
* `GET /transcript.txt` byte-identical to what the browser displayed (389 chars /
  72 words in the reference run).
* Watcher mode: a second browser followed the same live session over SSE with no
  microphone (47 deltas in a 30 s capture).
* Memory: model + KV cache = **5993 MiB of 8192**, leaving ~2.1 GiB for the
  TTS/translator stack. KV cache is 2,064 tokens (~5× a single stream's needs).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page says "model loading…" and Start is greyed out | Engine still warming up (~60 s). `./run_web.sh wait`. |
| No microphone option on the phone | You opened `:8272` over plain HTTP from a non-localhost address. Use `https://…:1443/`. |
| `4401 Unauthorized` on Start | `ASR_BROWSER_SECRET_KEY` is not in `ASR_SECRET_KEYS`. |
| Engine dies at startup: "No available memory for the cache blocks" | Something else is holding VRAM (the TTS/translator containers). Lower `ASR_GPU_MEM_UTIL` won't help below ~0.7 — stop the other service or use fp8 (see `PLAN.md`). |
| Transcript repeats a phrase | Model-level repetition; the vendor server has hallucination detection that resets state, but the client keeps what it already printed. See "Known issues". |
| Want a fresh log | `logs/requests/<requestId>.log`, one file per session (~80 KB per few minutes). |

## Known issues / not done yet

* **Repetition artifact.** On a hallucination reset the server discards its
  state but the already-sent text stays in the browser and in
  `/transcript.txt`, so a loop can persist visually.
* **VRAM is tight** if TTS/translator (~2 GiB) run alongside this (6.0 GiB);
  fp8 quantization of the ASR weights is the next lever, untested.
* `language: "English"` in the header did not stop the model transcribing
  Chinese audio as Chinese in one probe — worth a look if forced-language matters.
* No diarization (out of scope), no persistence across restarts, one publishing
  device at a time (a second publisher simply becomes the current session).
* Endurance beyond ~1 minute is not yet measured; `tools/ws_publish.py
  --duration 2h --speed 4` is the harness for that.
