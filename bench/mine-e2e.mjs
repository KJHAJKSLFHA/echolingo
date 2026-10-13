// End-to-end: feed a real video file into the page's file input and time the
// full recognition run. Private copy on port 9444 (the other session uses 9333).
//
// usage: node bench/mine-e2e.mjs <videoPath> [waitReadySeconds]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;
const URL_APP = 'http://127.0.0.1:8899/index.html';
const [videoPath, waitReadyArg] = process.argv.slice(2);
const WAIT_READY_MS = (Number(waitReadyArg) || 90) * 1000;
if (!videoPath) { console.error('usage: node bench/mine-e2e.mjs <videoPath> [waitReadySeconds]'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'echo-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDevTools() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('devtools 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        c.logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout: 1800000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

await waitDevTools();
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.navigate', { url: URL_APP });

// wait until app shell + model list is up
for (let i = 0; i < 200; i++) {
  if (await cdp.eval('document.querySelectorAll("#setAsrModel option").length > 0')) break;
  await sleep(200);
}

// wait for the ASR model to report ready (normal user flow: page opens, preload runs)
const readyT0 = Date.now();
let readyState = 'timeout';
while (Date.now() - readyT0 < WAIT_READY_MS) {
  const s = await cdp.eval('document.getElementById("txtAsr")?.textContent || ""');
  if (/就绪|ready/.test(s)) { readyState = 'ready'; break; }
  await sleep(250);
}
const modelReadyMs = Date.now() - readyT0;

// arm the watcher BEFORE handing over the file
await cdp.eval(`
  window.__m = { t0: 0, cues: 0, first: null, last: null, prog: [], toasts: [], done: false, sample: [], events: [] };
  window.__mReset = () => { const m = window.__m; m.t0 = performance.now(); m.cues = 0; m.first = null; m.last = null; m.done = false; };
  window.__mTick = () => {
    const m = window.__m; if (!m.t0) return null;
    const now = Math.round(performance.now() - m.t0);
    const n = document.querySelectorAll('#subs .cue').length;
    if (n !== m.cues) { m.cues = n; if (m.first === null) m.first = now; m.last = now; m.events.push({ t: now, cues: n }); }
    const p = (document.getElementById('progressText')?.textContent || '').trim();
    if (p && p !== m.prog.at(-1)?.p) m.prog.push({ t: now, p: p.slice(0, 80) });
    const to = (document.getElementById('toast')?.textContent || '').trim();
    if (to && to !== m.toasts.at(-1)) m.toasts.push(to.slice(0, 120));
    const busy = document.getElementById('btnTranscribe')?.disabled;
    const hint = document.querySelectorAll('.recog-hint').length;
    if (n > 0 && !busy && document.getElementById('progressWrap')?.hidden && !hint) m.done = true;
    return m;
  };
  'armed';
`);

// hand the real file to the input via CDP (no copy, no app changes)
const doc = await cdp.send('DOM.getDocument', { depth: 1 });
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cdp.send('DOM.setFileInputFiles', { files: [videoPath], nodeId: q.nodeId });
await cdp.eval('window.__mReset(); "reset"');

// make sure the change event actually reached the app; dispatch manually if not
await sleep(2500);
const started = await cdp.eval(`document.getElementById('player').src.startsWith('blob:') || !!document.getElementById('progressWrap') && !document.getElementById('progressWrap').hidden`);
if (!started) {
  await cdp.eval(`(() => { const i = document.getElementById('fileVideo'); i.dispatchEvent(new Event('change', { bubbles: true })); return 'redispatch'; })()`);
  await cdp.eval('window.__mReset(); "reset2"');
}

let m = null;
const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline) {
  m = await cdp.eval('window.__mTick()');
  if (m?.done) break;
  await sleep(500);
}

const extra = await cdp.eval(`({
  duration: document.getElementById('player').duration || null,
  videoWidth: document.getElementById('player').videoWidth || 0,
  asr: document.getElementById('txtAsr')?.textContent,
  mt: document.getElementById('txtMt')?.textContent,
  zh: [...document.querySelectorAll('#subs .cue .cue-zh')].slice(0,2).map(e=>e.textContent.trim()),
  en: [...document.querySelectorAll('#subs .cue .cue-en')].slice(0,2).map(e=>e.textContent.trim()),
  totalEnWords: [...document.querySelectorAll('#subs .cue .cue-en')].reduce((n,e)=>n+e.textContent.trim().split(/\\s+/).length,0)
})`);

const poolLogs = cdp.logs.filter((l) => /asr-pool|EchoLingo/.test(l));
console.log(JSON.stringify({
  file: videoPath,
  modelReady: readyState,
  modelReadyMs,
  video: { durationSec: extra.duration, hasVideo: extra.videoWidth > 0 },
  firstCueMs: m?.first,
  allCuesMs: m?.last,
  cues: m?.cues,
  asrStatus: extra.asr,
  mtStatus: extra.mt,
  enSample: extra.en,
  zhSample: extra.zh,
  totalEnWords: extra.totalEnWords,
  toasts: m?.toasts,
  progressTail: (m?.prog || []).slice(-8),
  cueEvents: (m?.events || []).slice(0, 12),
  poolLogs,
}, null, 2));

chrome.kill('SIGKILL');
process.exit(0);
