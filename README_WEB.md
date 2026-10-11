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
| `ASR_QUANTIZATION` | `fp8` | **The lever that made this fit beside the translator.** Weight-only fp8 (Marlin kernel) on the LM's linear layers: 3.80 GiB → ~2.5 GiB of weights. Applied in memory while loading, so the bf16 checkpoint on disk is never rewritten and re-quantizing costs ~2 s. Ampere (cc 8.6) has no fp8 tensor cores, so this stores fp8 and computes in bf16 — it buys VRAM, not speed. Set empty (`ASR_QUANTIZATION=`) for full bf16 on an idle card. |
| `ASR_KV_CACHE_GB` | `0.5` | Pinned KV cache. vLLM's default is "take whatever is still free", which grabbed 1.96 GiB / 18,288 tokens for a workload needing ~1k and OOM-killed the translator. `0` restores that greedy default. |
| `ASR_GPU_MEM_UTIL` | `0.55` | vLLM fraction of the *whole* card — not of what is free — and the engine refuses to start unless `free ≥ util × total`. Keep it above the pinned KV reservation but clear of the translator's 2.4 GiB. |
| `ASR_MAX_MODEL_LEN` | `1024` | A streaming prompt is one ~16 s audio window ≈ 200 audio tokens (12.5 tok/s) + a few dozen text tokens. |
| `ASR_MAX_NUM_BATCHED_TOKENS` | `1024` | Caps vLLM's profiling peak, which is what actually frees the KV cache. |
| `ASR_SKIP_MM_PROFILING` | `1` | Don't reserve memory for a worst-case multimodal input we never send. |
| `ASR_ENFORCE_EAGER` | `1` | Skips CUDA graphs (~0.5–1 GiB) in exchange for slightly slower chunks. |
| `ASR_MM_CACHE_GB` | `0` | The sliding 16 s window is never cache-relevant; hashing it costs CPU. |
| `ASR_MAX_NUM_SEQS` | `4` | One speaker per page; a wide continuous-batching window only buys scheduler buffers. |
| `VAD_USE_GPU` | `0` | FireRedVAD is 2.4 MB; CPU is cheaper than another CUDA context. |
| `ASR_LANGUAGE` | `English` | Sent in the page's WS header; also the default for `tools/ws_publish.py`. |
| `ASR_MODE` | `slow` | Vendor header field. Despite the name it maps to `rollback_punctuation` in `r2t2_asr.py`, not to a speed switch. |
| `ASR_SECRET_KEYS` | `test0102` | Keys the ASR websocket accepts (shared secret, not authentication). |
| `ASR_BROWSER_SECRET_KEY` | `test0102` | The key handed to the page by `/api/config`; must appear in `ASR_SECRET_KEYS`. |
| `ASR_STALE_AFTER_SECONDS` | `180` | If inference makes no progress this long while connected, `/health` returns 503 so a supervisor can restart. `0` disables. |
| `ASR_PORT` / `ASR_TLS_PORT` | `8272` / `10102` | Host ports. TLS runs with `network_mode: host`, so `:10102` is what `deploy/nginx.r2t2.conf` actually listens on and `ASR_TLS_PORT` only changes the printed URL. |

## Sharing the 8 GB card with translator + TTS

One RTX 3070 (8 GB, 7.66 GiB usable) runs this ASR engine, `hat_translator`
(2.4 GiB) and `hat_tts` (CPU-only, no VRAM). What it took, in the order the
failures showed up:

1. **fp8 weights** (`ASR_QUANTIZATION=fp8`). bf16 weights are 3.80 GiB; the LM
   linear layers are 2.625 GiB of that and shrink to ~1.31 GiB. The audio tower
   (0.56 GiB) and embedding table (0.58 GiB) stay bf16 — vLLM's
   `Qwen3ASRAudioEncoder` accepts no `quant_config`, so fp8 cannot reach them.
2. **A pinned KV cache** (`ASR_KV_CACHE_GB=0.5`). Left alone, vLLM reserved
   1.96 GiB / 18,288 tokens for a workload that needs ~1k, and starved the
   translator into an OOM crash-loop. Pinning it also skips vLLM's memory
   profiling, so startup gets *faster* (~2 s), not slower.
3. **Boot ordering.** `gpu_memory_utilization` is a fraction of the whole card and
   the engine refuses to start unless `free ≥ util × total`; worse, the load peak
   (~4.9 GiB) is far above the ~4.0 GiB steady state because online quantization
   holds the bf16 checkpoint while writing the fp8 copy. So `hat_translator`
   waits on this service's healthcheck instead of racing it.

Measured end state: **4050 + 2502 = 6630 MiB of 8192**, ~1.5 GiB spare.

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
* Memory, with `hat_translator` resident on the same card (2026-10-11): ASR
  **4050 MiB**, translator **2502 MiB**, total **6630 MiB of 8192** — ~1.5 GiB of
  headroom. KV cache is pinned at 0.5 GiB / 4,672 tokens (~4× a single stream).
* Cold-boot ordering: `hat_translator` stays blocked on `r2t2-web`'s healthcheck
  until the model is loaded, then starts; verified from an empty GPU.
* fp8 transcripts are unchanged vs the bf16 run on both `resources/test.wav` and
  `resources/english.wav`; `delta latency p50 = 72 ms`, p95 112 ms.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page says "model loading…" and Start is greyed out | Engine still warming up (~60 s). `./run_web.sh wait`. |
| No microphone option on the phone | You opened `:8272` over plain HTTP from a non-localhost address. Use `https://…:10102/`. |
| `4401 Unauthorized` on Start | `ASR_BROWSER_SECRET_KEY` is not in `ASR_SECRET_KEYS`. |
| Engine dies **while loading weights**: CUDA OOM with ~4.9 GiB already claimed | The translator was already up. The load peak (bf16 checkpoint resident while it is being quantized to fp8) is far above the steady state, so the ASR engine must come up **first**. In the merged compose `hat_translator` has `depends_on: r2t2-web: condition: service_healthy` for exactly this. |
| Engine starts but dies later: "No available memory for the cache blocks" | `ASR_KV_CACHE_GB` was set too low (or `0`, which returns vLLM to its greedy default). A stream needs ~1k tokens; 0.5 GiB ≈ 4.6k. |
| Transcript repeats a phrase | Model-level repetition; the vendor server has hallucination detection that resets state, but the client keeps what it already printed. See "Known issues". |
| Want a fresh log | `logs/requests/<requestId>.log`, one file per session (~80 KB per few minutes). |

## Known issues / not done yet

* **Repetition artifact.** On a hallucination reset the server discards its
  state but the already-sent text stays in the browser and in
  `/transcript.txt`, so a loop can persist visually.
* **VRAM is shared, and boot order is load-bearing.** With fp8 + pinned KV this
  service settles at ~4.0 GiB and coexists with `hat_translator`'s 2.4 GiB, but
  its *load* peak is ~4.9 GiB, so it has to come up first (the merged compose
  uses `depends_on: r2t2-web: condition: service_healthy`). Consequence: if
  r2t2-web needs to reload *while* the translator holds VRAM, it cannot, and the
  translator must be stopped first. Dropping that constraint would mean
  quantizing offline to a real fp8 checkpoint (loads ~2.5 GiB with no bf16
  staging pass) — deliberately not done, since we boot once per event.
* **fp8 is a quality trade-off, measured not to bite here.** Verified only on the
  two clips in `resources/`. For a talk where accuracy is critical, compare
  against `ASR_QUANTIZATION=` on a card with the translator stopped.
* `language: "English"` in the header did not stop the model transcribing
  Chinese audio as Chinese in one probe — worth a look if forced-language matters.
* No diarization (out of scope), no persistence across restarts, one publishing
  device at a time (a second publisher simply becomes the current session).
* Endurance beyond ~1 minute is not yet measured; `tools/ws_publish.py
  --duration 2h --speed 4` is the harness for that.
