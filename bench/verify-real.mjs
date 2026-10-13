// 往**已运行的** Electron 应用里塞一个真实视频，量完整耗时。
// usage: node bench/verify-real.mjs <videoPath> [port]
const PORT = Number(process.argv[3] || 9555);
const mediaPath = process.argv[2];
if (!mediaPath) { console.error('usage: node bench/verify-real.mjs <videoPath> [port]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('找不到页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
async function cmd(method, params) {
  const i = ++id;
  const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (m.error) throw new Error(JSON.stringify(m.error));
  return m.result;
}
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;

await cmd('Runtime.enable', {});
await cmd('DOM.enable', {});

// 等模型预热完
let ready = 'timeout';
for (let i = 0; i < 360; i++) {
  const s = await ev('document.getElementById("txtAsr")?.textContent || ""');
  if (/就绪|ready/.test(s)) { ready = 'ready'; break; }
  await sleep(500);
}

const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
if (!q.nodeId) throw new Error('找不到 #fileVideo');

await ev(`window.__r = { t0: performance.now(), first: null, recogDone: null, cues: 0, marks: [] };
  window.__rMark = (k, v) => { window.__r.marks.push(Object.assign({ k, t: Math.round(performance.now() - window.__r.t0) }, v || {})); };`);
await cmd('DOM.setFileInputFiles', { files: [mediaPath], nodeId: q.nodeId });

const t0 = Date.now();
let first = null, recogDone = null, allDone = null, cues = 0, lastText = '';
const timeline = [];
while (Date.now() - t0 < 30 * 60 * 1000) {
  const st = await ev(`(function(){
    const n = document.querySelectorAll('#subs .cue').length;
    const p = (document.getElementById('progressText')||{}).textContent || '';
    const hidden = !!document.getElementById('progressWrap')?.hidden;
    const busy = !!document.getElementById('btnTranscribe')?.disabled;
    return JSON.stringify({ n, p, hidden, busy, dur: document.getElementById('player').duration || null });
  })()`);
  const s = JSON.parse(st);
  const el = Date.now() - t0;
  if (s.n !== cues) { cues = s.n; if (first === null) { first = el; timeline.push({ t: el, cues: s.n }); } }
  if (s.p && s.p !== lastText) { lastText = s.p; timeline.push({ t: el, p: s.p.slice(0, 70) }); }
  if (recogDone === null && /翻译|Translating/.test(s.p)) recogDone = el;
  if (cues > 0 && s.hidden && !s.busy) { allDone = el; break; }
  await sleep(1000);
}

const tail = await ev(`JSON.stringify({
  duration: document.getElementById('player').duration,
  cues: document.querySelectorAll('#subs .cue').length,
  zh: document.querySelectorAll('#subs .cue .cue-zh').length,
  words: [...document.querySelectorAll('#subs .cue .cue-en')].reduce((n,e)=>n+e.textContent.trim().split(/\\s+/).length,0),
  en: [...document.querySelectorAll('#subs .cue .cue-en')].slice(0,2).map(e=>e.textContent.trim()),
  zhSample: [...document.querySelectorAll('#subs .cue .cue-zh')].slice(0,1).map(e=>e.textContent.trim()),
  toast: (document.getElementById('toast')||{}).textContent || ''
})`);

console.log(JSON.stringify({
  media: mediaPath,
  modelReady: ready,
  videoDurationSec: JSON.parse(tail).duration,
  firstCueMs: first,
  recognitionDoneMs: recogDone,
  everythingDoneMs: allDone,
  cues: JSON.parse(tail).cues,
  translatedCues: JSON.parse(tail).zh,
  totalEnWords: JSON.parse(tail).words,
  enSample: JSON.parse(tail).en,
  zhSample: JSON.parse(tail).zhSample,
  toast: JSON.parse(tail).toast,
  timeline: timeline.slice(0, 16),
  poolLogs: logs.filter((l) => /asr-pool|mt\]|并行/.test(l)),
}, null, 2));
ws.close();
