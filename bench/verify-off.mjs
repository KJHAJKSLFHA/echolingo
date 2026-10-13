// 验证 P0 修复：把「逐词时间戳」设为 off（就是以前会把长视频识别成空的那条路），
// 确认现在能正常出句，而且句子是按标点切开的、不是每段一整坨。
// usage: node bench/verify-off.mjs <mediaPath> [port]
const PORT = Number(process.argv[3] || 9555);
const mediaPath = process.argv[2];
if (!mediaPath) { console.error('usage: node bench/verify-off.mjs <mediaPath> [port]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
async function cmd(method, params) { const i = ++id; const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); return m.result; }
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value;

await cmd('Runtime.enable', {});
await cmd('DOM.enable', {});

// 切到「关闭逐词时间戳」
await ev(`(function(){
  const s = document.getElementById('setWordTs');
  s.value = 'off';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`);

const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [mediaPath], nodeId: q.nodeId });

const t0 = Date.now();
let cues = 0, first = null;
while (Date.now() - t0 < 10 * 60 * 1000) {
  const s = JSON.parse(await ev(`JSON.stringify({
    n: document.querySelectorAll('#subs .cue').length,
    hidden: !!document.getElementById('progressWrap')?.hidden,
    busy: !!document.getElementById('btnTranscribe')?.disabled,
    p: (document.getElementById('progressText')||{}).textContent || ''
  })`));
  if (s.n !== cues) { cues = s.n; if (first === null) first = Date.now() - t0; }
  if (cues > 0 && s.hidden && !s.busy && !/翻译|Translating/.test(s.p)) break;
  if (cues > 0 && s.hidden && !s.busy && /翻译/.test(s.p)) break;
  await sleep(600);
}

const out = await ev(`JSON.stringify({
  wordTs: document.getElementById('setWordTs').value,
  cues: document.querySelectorAll('#subs .cue').length,
  toast: (document.getElementById('toast')||{}).textContent || '',
  lens: [...document.querySelectorAll('#subs .cue .cue-en')].map(e => e.textContent.trim().length).slice(0, 12),
  sample: [...document.querySelectorAll('#subs .cue .cue-en')].slice(0, 6).map(e => e.textContent.trim())
}, null, 1)`);

console.log('firstCueMs =', first);
console.log(out);
ws.close();
