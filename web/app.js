/* Live transcription page.
 *
 * Flow: microphone -> AudioWorklet (down-mix + resample to 16 kHz Int16) ->
 * WebSocket to the ASR server -> incremental text deltas appended to the view.
 *
 * Two roles:
 *   publisher (default) — captures the microphone and streams it
 *   watcher  (?watch=1) — no microphone; follows the live session over SSE
 */

(() => {
  'use strict';

  const EOS = 'YOUDAO_ONETIME_ASR_STREAM_EOS';
  const FRAME_SAMPLES = 2560;            // 160 ms at 16 kHz, sent as 5120 bytes
  const MAX_BUFFERED_BYTES = 64 * 1024;  // stop queueing frames if the socket is this behind
  const MAX_QUEUED_SAMPLES = 16000 * 3;  // 3 s of audio buffered locally before we drop
  const CONFIG_TIMEOUT_MS = 1500;

  const params = new URLSearchParams(location.search);
  const WATCH = params.get('watch') === '1';

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'),
    metrics: $('metrics'),
    notice: $('notice'),
    transcript: $('transcript'),
    jump: $('jump'),
    toggle: $('toggle'),
    copy: $('copy'),
    download: $('download'),
    clear: $('clear'),
    session: $('session'),
    backend: $('backend'),
  };

  const DEFAULTS = {
    ws_path: '/asr_stream_api_v1',
    secret_key: 'test0102',
    language: 'English',
    mode: 'slow',
    use_vad: false,
    sample_rate: 16000,
  };
  const config = Object.assign({}, DEFAULTS);

  const state = {
    phase: 'booting',
    // One requestId per explicit Start. Reconnect attempts reuse it so the
    // server keeps one continuous transcript instead of starting a new document.
    requestId: null,
    ws: null,
    audio: null,
    text: '',
    attempts: 0,
    userStopped: true,
    modelReady: false,
    override: false,
    droppedSamples: 0,
    lastLagMs: null,
    reconnectTimer: null,
    wakeLock: null,
  };

  // ---------- helpers ----------

  function withTimeout(promise, ms, message) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  const apiBase = () => {
    const forced = params.get('api');
    if (forced) return forced.replace(/\/$/, '');
    return '';
  };
  const apiUrl = (path) => `${apiBase()}${path}`;

  function setPhase(phase, note) {
    state.phase = phase;
    const labels = {
      booting: ['Checking server', 'connecting'],
      idle: ['Idle', 'stopped'],
      mic: ['Microphone…', 'mic'],
      connecting: ['Connecting', 'connecting'],
      live: ['Transcribing', 'live'],
      reconnecting: ['Reconnecting', 'reconnecting'],
      stopping: ['Stopping', 'connecting'],
      stopped: ['Stopped', 'stopped'],
      error: ['Error', 'error'],
      watching: ['Watching', 'live'],
    };
    const [text, pill] = labels[phase] || [phase, 'idle'];
    els.status.textContent = text;
    els.status.dataset.state = pill;
    if (note) setNotice(note);
    if (phase === 'live' || phase === 'reconnecting' || phase === 'connecting' || phase === 'mic' || phase === 'stopping') {
      els.toggle.textContent = phase === 'stopping' ? 'Stopping…' : 'Stop';
      els.toggle.classList.add('recording');
      els.toggle.disabled = phase === 'stopping';
    } else {
      els.toggle.textContent = 'Start';
      els.toggle.classList.remove('recording');
      els.toggle.disabled = WATCH || (!state.override && !state.modelReady);
    }
  }

  let noticeTimer = null;
  function setNotice(message, ms) {
    els.notice.textContent = message || '';
    if (noticeTimer) clearTimeout(noticeTimer);
    if (ms) noticeTimer = setTimeout(() => { els.notice.textContent = ''; }, ms);
  }

  // Autoscroll only while the user is at the bottom; never fight a scroll-up.
  let pinned = true;
  function updatePinned() {
    const el = els.transcript;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    els.jump.classList.toggle('show', !pinned && state.text.length > 0);
  }
  function scrollToBottom() {
    els.transcript.scrollTop = els.transcript.scrollHeight;
    pinned = true;
    els.jump.classList.remove('show');
  }

  function render() {
    els.transcript.textContent = state.text;
    els.transcript.classList.toggle('empty', state.text.length === 0);
    const words = state.text.trim() ? state.text.trim().split(/\s+/).length : 0;
    const bits = [`${words} words`];
    if (state.lastLagMs != null) bits.push(`lag ${Math.round(state.lastLagMs)} ms`);
    if (state.droppedSamples > 0) bits.push(`dropped ${(state.droppedSamples / 16000).toFixed(1)} s`);
    els.metrics.textContent = bits.join(' · ');
    if (pinned) scrollToBottom();
  }

  function appendText(piece) {
    if (!piece) return;
    state.text += piece;
    render();
  }

  // ---------- config / health ----------

  async function loadConfig() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    try {
      const res = await fetch(apiUrl('/api/config'), { signal: controller.signal, cache: 'no-store' });
      if (res.ok) Object.assign(config, await res.json());
    } catch (err) {
      // Served statically, or the backend is still booting: defaults are usable.
    } finally {
      clearTimeout(timer);
    }
    if (params.get('key')) config.secret_key = params.get('key');
    if (params.get('lang')) config.language = params.get('lang');
    if (params.get('mode')) config.mode = params.get('mode');
    els.download.href = apiUrl('/transcript.txt');
  }

  async function pollHealth() {
    try {
      const res = await fetch(apiUrl('/health'), { cache: 'no-store' });
      const body = await res.json();
      state.modelReady = !!body.model_ready;
      els.backend.textContent = state.modelReady
        ? `model ready · ${body.active_connections || 0} stream(s)`
        : 'model loading…';
    } catch (err) {
      state.modelReady = false;
      els.backend.textContent = 'server unreachable';
    }
    if (state.userStopped && !state.modelReady) {
      els.toggle.disabled = !state.override;
      setNotice('The server model is still loading — this takes a minute or two on first start. Press and hold is not needed; just tap Start again once it is ready, or tap Start now to try anyway.');
    } else if (state.userStopped) {
      els.toggle.disabled = false;
      if (state.override) setNotice('');
    }
  }

  // ---------- audio capture ----------

  async function startAudio(onFrame, onDrops) {
    // Created before any await: iOS only allows an AudioContext inside the
    // gesture, and resuming a suspended one later is unreliable.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    // resume() must never be awaited bare: it can stay pending indefinitely when
    // the browser has no usable audio output device (headless Chrome, some
    // Android WebViews), and iOS hands back a suspended context. Race it.
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });

    const source = ctx.createMediaStreamSource(stream);
    await ctx.audioWorklet.addModule(new URL('recorder-worklet.js', location.href).href);
    const worklet = new AudioWorkletNode(ctx, 'pcm-sampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { targetRate: 16000, frameSamples: FRAME_SAMPLES },
    });
    worklet.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'frame') onFrame(data.frame);
      else if (data.type === 'drops') onDrops(data.droppedSamples);
    };

    // A silent sink keeps the graph pulled on browsers that idle an unconnected
    // worklet, without ever routing the microphone to the speaker.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(ctx.destination);

    // A silent oscillator: without it Safari suspends the context when the tab
    // is backgrounded, which silently freezes transcription.
    const keepAlive = ctx.createOscillator();
    const keepGain = ctx.createGain();
    keepGain.gain.value = 0;
    keepAlive.connect(keepGain);
    keepGain.connect(ctx.destination);
    keepAlive.start();

    return { ctx, stream, source, worklet, sink, keepAlive };
  }

  function stopAudio(audio) {
    if (!audio) return;
    try { audio.keepAlive && audio.keepAlive.stop(); } catch (err) {}
    try { audio.worklet && audio.worklet.disconnect(); } catch (err) {}
    try { audio.source && audio.source.disconnect(); } catch (err) {}
    try { audio.sink && audio.sink.disconnect(); } catch (err) {}
    if (audio.stream) audio.stream.getTracks().forEach((t) => { try { t.stop(); } catch (err) {} });
    if (audio.ctx) audio.ctx.close().catch(() => {});
  }

  // ---------- frame queue ----------

  // The worklet produces frames at real-time rate regardless of socket health,
  // so the queue is bounded and drops the oldest audio rather than growing.
  let queue = new Int16Array(0);

  function enqueue(frame) {
    const merged = new Int16Array(queue.length + frame.length);
    merged.set(queue, 0);
    merged.set(frame, queue.length);
    queue = merged;
    if (queue.length > MAX_QUEUED_SAMPLES) {
      const excess = queue.length - MAX_QUEUED_SAMPLES;
      queue = queue.subarray(excess);
      state.droppedSamples += excess;
      render();
    }
    flushFrames();
  }

  function flushFrames() {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length >= FRAME_SAMPLES && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
      const frame = queue.subarray(0, FRAME_SAMPLES);
      // Copy: subarray shares the buffer and send() is async.
      ws.send(new Int16Array(frame).buffer);
      queue = queue.subarray(FRAME_SAMPLES);
    }
  }

  // ---------- websocket ----------

  function wsUrl() {
    if (params.get('ws')) return params.get('ws');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}${config.ws_path}`;
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (err) {
        reject(new Error(`could not open ${wsUrl()}: ${err.message}`));
        return;
      }
      ws.binaryType = 'arraybuffer';

      const settled = (fn) => (value) => {
        if (ws._settled) return;
        ws._settled = true;
        fn(value);
      };

      const failTimer = setTimeout(() => {
        if (!ws._settled) {
          try { ws.close(); } catch (err) {}
          reject(new Error('timed out waiting for the server to accept the stream'));
        }
      }, 20000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          channels: 1,
          sample_rate: config.sample_rate,
          requestId: state.requestId,
          language: config.language,
          use_vad: !!config.use_vad,
          secret_key: config.secret_key,
          mode: config.mode,
        }));
      };

      ws.onmessage = (event) => {
        const raw = event.data;
        if (typeof raw !== 'string') return;
        let msg;
        try { msg = JSON.parse(raw); } catch (err) { return; }
        if (!msg || typeof msg !== 'object' || !('status' in msg)) return; // bare {} keep-alive
        if (msg.status === 'connected') {
          clearTimeout(failTimer);
          state.attempts = 0;
          settled(resolve)(ws);
          return;
        }
        if (msg.status === 'success') {
          const inner = msg.msg || {};
          if (typeof inner.lag_ms === 'number') state.lastLagMs = inner.lag_ms;
          appendText(inner.text || '');
          return;
        }
        if (msg.status === 'error') {
          clearTimeout(failTimer);
          settled(reject)(new Error(msg.msg || 'server rejected the stream'));
        }
      };

      ws.onclose = (event) => {
        clearTimeout(failTimer);
        const reasons = { 4401: 'Server rejected the access key (check ASR_BROWSER_SECRET_KEY).', 1011: 'Server model is not ready yet.' };
        const reason = reasons[event.code] || (event.reason || `connection closed (code ${event.code})`);
        if (!ws._settled) {
          ws._settled = true;
          reject(new Error(reason));
        } else {
          handleUnexpectedClose(reason);
        }
      };

      ws.onerror = () => {
        if (!ws._settled) {
          clearTimeout(failTimer);
          ws._settled = true;
          reject(new Error('websocket error — is the transcription server running?'));
        }
      };
    });
  }

  function handleUnexpectedClose(reason) {
    if (state.userStopped) {
      setPhase('stopped');
      return;
    }
    if (state.attempts >= 5) {
      state.userStopped = true;
      stopAudio(state.audio);
      state.audio = null;
      setPhase('error', `${reason} — gave up after 5 attempts. Press Start to try again.`);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, state.attempts), 15000);
    state.attempts += 1;
    setPhase('reconnecting', `${reason} — retry ${state.attempts} of 5 in ${Math.round(delay / 1000)} s`);
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(async () => {
      try {
        // Reuse state.requestId: the server resumes the same transcript document.
        if (!state.audio) state.audio = await startAudio(enqueue, (n) => { state.droppedSamples = n; });
        state.ws = await openSocket();
        setPhase('live');
      } catch (err) {
        handleUnexpectedClose(err.message);
      }
    }, delay);
  }

  // ---------- start / stop ----------

  async function start() {
    clearTimeout(state.reconnectTimer);
    state.userStopped = false;
    state.attempts = 0;
    state.text = '';          // a fresh Start always begins a clean document
    state.droppedSamples = 0;
    state.lastLagMs = null;
    queue = new Int16Array(0);
    state.requestId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    els.session.textContent = state.requestId;
    render();
    setPhase('mic');

    try {
      // Bounded: a microphone or audio stack that never answers must surface as
      // an error the user can retry, not a spinner that outlives the talk.
      state.audio = await withTimeout(
        startAudio(enqueue, (n) => { state.droppedSamples = n; }),
        15000,
        'The browser did not finish opening the microphone within 15 s.'
      );
    } catch (err) {
      state.userStopped = true;
      setPhase('error', describeMicError(err));
      return;
    }

    setPhase('connecting');
    try {
      state.ws = await openSocket();
    } catch (err) {
      stopAudio(state.audio);
      state.audio = null;
      state.userStopped = true;
      setPhase('error', err.message);
      return;
    }
    setPhase('live');
    acquireWakeLock();
  }

  function describeMicError(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone permission was denied. Tap the page-info / lock icon in the address bar, allow the microphone, then press Start again. (Browsers only allow this over HTTPS or localhost.)';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone was found. Check that one is connected and not in use by another app.';
    }
    return `Could not start the microphone: ${err && err.message ? err.message : err}`;
  }

  async function stop() {
    setPhase('stopping');
    state.userStopped = true;
    clearTimeout(state.reconnectTimer);
    const ws = state.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      flushFrames();
      try { ws.send(EOS); } catch (err) {}
      setTimeout(() => { try { ws.close(); } catch (err) {} }, 800);
    }
    state.ws = null;
    stopAudio(state.audio);
    state.audio = null;
    queue = new Int16Array(0);
    releaseWakeLock();
    setPhase('stopped', 'Stopped. Press Start to begin a new transcript.');
  }

  // ---------- wake lock ----------

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) { /* not supported / denied: harmless */ }
  }
  function releaseWakeLock() {
    if (state.wakeLock) { try { state.wakeLock.release(); } catch (err) {} state.wakeLock = null; }
  }

  // ---------- watcher mode ----------

  function startWatcher() {
    setPhase('watching');
    els.toggle.style.display = 'none';
    let source = null;
    let seenSession = null;
    let retries = 0;

    const connect = () => {
      source = new EventSource(apiUrl('/api/stream'));
      source.onopen = () => { retries = 0; setPhase('watching'); };
      source.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch (err) { return; }
        if (data.session_id && data.session_id !== seenSession) {
          seenSession = data.session_id;
          state.text = '';
          els.session.textContent = seenSession;
        }
        appendText(data.text || '');
      };
      source.onerror = () => {
        if (source) source.close();
        retries += 1;
        if (retries > 20) { setPhase('error', 'Lost the live feed.'); return; }
        setPhase('reconnecting', `Live feed dropped — retry ${retries} in a moment.`);
        setTimeout(connect, Math.min(1000 * retries, 8000));
      };
    };
    connect();
  }

  // ---------- wiring ----------

  els.toggle.addEventListener('click', () => {
    if (state.userStopped || state.phase === 'error' || state.phase === 'stopped' || state.phase === 'idle') {
      start();
    } else {
      stop();
    }
  });

  els.clear.addEventListener('click', () => {
    state.text = '';
    render();
    setNotice('View cleared. The server transcript keeps running until the next Start.', 4000);
  });

  els.copy.addEventListener('click', async () => {
    const text = state.text || '';
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied.', 1500);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setNotice('Copied.', 1500); }
      catch (err2) { setNotice('Copy is not available in this browser.', 3000); }
      ta.remove();
    }
  });

  els.jump.addEventListener('click', scrollToBottom);
  els.transcript.addEventListener('scroll', updatePinned);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.userStopped) acquireWakeLock();
  });

  window.addEventListener('pagehide', () => {
    if (!state.userStopped && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(EOS); } catch (err) {}
    }
  });

  async function boot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Watch mode still works without a microphone.
      if (!WATCH) setNotice('This browser cannot capture audio and is not a secure context. Open the page over HTTPS (port 1443) or on localhost.', 12000);
    }
    await loadConfig();
    if (WATCH) { startWatcher(); } else { setPhase('idle'); }
    pollHealth();
    setInterval(pollHealth, 5000);
  }

  boot();
})();
