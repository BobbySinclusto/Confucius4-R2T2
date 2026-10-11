#!/usr/bin/env node
/* End-to-end browser test: drives the real page in headless Chromium over the
 * Chrome DevTools Protocol with no npm dependencies (Node >= 22 has global
 * fetch and WebSocket).
 *
 * Chromium is launched separately with a WAV file wired to the fake microphone,
 * so this exercises the whole path: getUserMedia -> AudioWorklet resampler ->
 * WebSocket -> ASR server -> transcript rendered in the DOM.
 *
 *   chromium --headless=new --no-sandbox --remote-debugging-port=9222 \
 *     --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
 *     --use-file-for-fake-audio-capture=/abs/path/english.wav about:blank &
 *   node tools/browser_e2e.js --url http://localhost:8272/ --seconds 30
 */

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const CDP_PORT = args.port || '9222';
const URL_UNDER_TEST = args.url || 'http://localhost:8272/';
const SECONDS = parseInt(args.seconds || '30', 10);
const WATCH = args.watch === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWsUrl() {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (!res.ok) throw new Error(`CDP not reachable on ${CDP_PORT}: ${res.status}`);
    return (await res.json()).webSocketDebuggerUrl;
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(new Error(`websocket error: ${e.message || e}`));
    });
}

async function main() {
    const wsUrl = await browserWsUrl();
    const ws = await connect(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const problems = [];
    const loaded = [];

    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || '')}`));
            else resolve(msg.result);
            return;
        }
        if (msg.method === 'Console.messageAdded') {
            const m = msg.params.message;
            if (m.level === 'error' || m.level === 'warning') problems.push(`console.${m.level}: ${m.text}`);
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            problems.push(`uncaught: ${d.exception?.description || d.text}`);
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const t = msg.params.type;
            if (t === 'error' || t === 'warning') {
                problems.push(`console.${t}: ${(msg.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
            }
        }
        if (msg.method === 'Log.entryAdded') {
            const e = msg.params.entry;
            if (e.level === 'error') problems.push(`log.error: ${e.text} (${e.url || ''})`);
            if (/favicon/i.test(e.text || '')) return;
            loaded.push(`${e.level}: ${e.text}`);
        }
    };

    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });

    await send('Runtime.enable', {}, sessionId);
    await send('Console.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);

    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
        return r.result.value;
    };

    console.log(`navigating to ${URL_UNDER_TEST}`);
    await send('Page.navigate', { url: URL_UNDER_TEST }, sessionId);
    await sleep(3000);

    console.log(`page title: ${await evaluate('document.title')}`);
    console.log(`status pill: ${await evaluate("document.getElementById('status').textContent")}`);
    console.log(`toggle label: ${await evaluate("document.getElementById('toggle').textContent")}`);

    if (!WATCH) {
        const disabled = await evaluate("document.getElementById('toggle').disabled");
        console.log(`start button disabled: ${disabled}`);
        await evaluate("document.getElementById('toggle').click(); 'clicked'");
        console.log('clicked Start; streaming fake microphone audio…');
    }

    const deadline = Date.now() + SECONDS * 1000;
    let lastLen = -1;
    let stableFor = 0;
    while (Date.now() < deadline) {
        await sleep(2000);
        const state = await evaluate(
            `JSON.stringify({
              phase: document.getElementById('status').textContent,
              len: document.getElementById('transcript').textContent.length,
              metrics: document.getElementById('metrics').textContent,
              notice: document.getElementById('notice').textContent,
              session: document.getElementById('session').textContent,
            })`
        );
        const s = JSON.parse(state);
        if (s.len !== lastLen) {
            lastLen = s.len;
            stableFor = 0;
            console.log(`  [${s.phase}] chars=${s.len} ${s.metrics} ${s.notice ? '| ' + s.notice.slice(0, 120) : ''}`);
        } else {
            stableFor += 2;
        }
        if (s.notice && /permission|denied|error|not ready|unreachable/i.test(s.notice)) {
            console.log(`  NOTICE: ${s.notice.slice(0, 200)}`);
        }
    }

    const final = await evaluate(
        `JSON.stringify({
            text: document.getElementById('transcript').textContent,
            phase: document.getElementById('status').textContent,
            metrics: document.getElementById('metrics').textContent,
            notice: document.getElementById('notice').textContent,
            session: document.getElementById('session').textContent,
        })`
    );
    const f = JSON.parse(final);
    console.log('\n================ BROWSER RESULT ================');
    console.log(`phase   : ${f.phase}`);
    console.log(`session : ${f.session}`);
    console.log(`metrics : ${f.metrics}`);
    console.log(`notice  : ${f.notice}`);
    console.log(`text    : ${JSON.stringify(f.text)}`);
    console.log('-------------- page/network problems -------------');
    console.log(problems.length ? problems.slice(0, 20).join('\n') : '(none)');
    console.log('================================================');

    if (!WATCH && f.text.trim().length === 0) {
        console.log('\nRESULT: FAIL — no transcript text rendered in the browser.');
        process.exitCode = 2;
    } else {
        console.log('\nRESULT: PASS — transcript rendered in the browser.');
    }

    ws.close();
}

main().catch((err) => {
    console.error(`driver error: ${err.message}`);
    process.exitCode = 1;
});
