# Web frontend

No build step, no dependencies, no network fetches — the whole app is four
files, safe to serve from an offline LAN.

| File | Role |
|---|---|
| `index.html` | Served at `/`. References assets **relatively** (`./app.js`) so the same files work behind the backend and from a plain static server. |
| `app.js` | State machine, WebSocket client, frame queue, SSE watcher, UI. |
| `recorder-worklet.js` | `AudioWorkletProcessor`: device audio → mono → 16 kHz → Int16 → 5120-byte frames. |
| `style.css` | Mobile-first dark UI. |

## Pipeline

```
getUserMedia (AEC + noise suppression + AGC)
  → AudioContext (device rate, usually 44.1/48 kHz)
  → AudioWorkletNode 'pcm-sampler'   down-mix, linear-interpolation resample,
                                       fractional read position carried across
                                       the 128-sample quantum
  → port message: Int16Array(2560)   exactly 160 ms = 5120 bytes
  → app.js frame queue               bounded at 3 s; drops oldest, counts drops
  → WebSocket binary frame           sent only while ws.bufferedAmount < 64 KB
```

An `AudioWorkletNode` is used instead of `ScriptProcessorNode` because the
latter is deprecated and drops samples on iOS. The worklet is wired to a
zero-gain sink so browsers that idle unconnected nodes still pull it, and a
silent oscillator keeps Safari from suspending the context when the tab is
backgrounded.

## URL parameters (all optional, for testing)

| Parameter | Effect |
|---|---|
| `?watch=1` | Follower mode: no microphone, renders the live session from `/api/stream` (SSE). |
| `?ws=wss://host:port/asr_stream_api_v1` | Explicit socket URL; bypasses `/api/config`. |
| `?api=http://host:port` | Base URL for `/api/config`, `/api/stream`, `/transcript.txt` when the page is served from somewhere other than the backend. |
| `?key=`, `?lang=`, `?mode=` | Override the matching `/api/config` field. |

`/api/config` is fetched with a 1.5 s timeout and falls back to defaults, so the
page still works when served statically.

## Testing without the GPU

A protocol-faithful mock of the ASR websocket lives in `tools/mock_asr_server.py`
(it emits the bare `{}` keep-alives too, which is the easy thing to get wrong).

```bash
# 1. mock ASR
/tmp/r2t2tools/bin/python tools/mock_asr_server.py --port 8273 &

# 2. serve the page
python3 -m http.server 8080 --directory web &

# 3. drive it in headless Chromium with a fake microphone
chromium --headless=new --no-sandbox --disable-gpu \
  --autoplay-policy=no-user-gesture-required --mute-audio \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture="$PWD/resources/english.wav" \
  about:blank &

node tools/browser_e2e.js --url http://localhost:8080/?ws=ws://localhost:8273/asr_stream_api_v1 --seconds 20
```

`tools/browser_e2e.js` speaks the Chrome DevTools Protocol directly (Node's
built-in `fetch` + `WebSocket`, no npm). It clicks Start, polls the transcript
element, and fails if nothing rendered or the page logged an error.

### Headless Chromium gotchas

* Without `--autoplay-policy=no-user-gesture-required --mute-audio`, headless
  Chrome has no usable audio output device and **`AudioContext.resume()` never
  resolves**. `app.js` therefore never awaits `resume()` bare — it races it with
  a 1.5 s timeout — and wraps microphone startup in a 15 s deadline so a hung
  audio stack surfaces as a retryable error instead of a permanent spinner.
* `--use-file-for-fake-audio-capture` wants a 16-bit PCM WAV; it plays once and
  then goes silent.
* Self-signed HTTPS needs `--ignore-certificate-errors`.

## Behaviour worth knowing

* One `requestId` per explicit **Start**, reused across reconnect attempts, so
  the server keeps one continuous transcript document instead of starting a new
  one after a network blip. A user-initiated Start always mints a fresh id and
  clears the view.
* Auto-scroll only while the view is already pinned to the bottom; scrolling up
  reveals a "Jump to latest" button instead of being yanked back.
* **Clear** empties the browser view only — the server transcript keeps running.
* Screen wake lock is requested while transcribing and re-acquired on tab
  re-entry; failures are ignored (unsupported on some WebViews).
