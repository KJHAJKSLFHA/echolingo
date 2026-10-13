// 西语链路端到端测试：切到多语言 whisper → 导入西语音频 → 看识别结果与中文译文。
// 自己起一个 headless Chrome（CDP 端口 9333），别和本地 HTTP 端口混。
// usage: node bench/test-spanish.mjs [httpPort] [audioPath]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const AUDIO = process.argv[3] || '/Users/orion/WorkBuddy/2026-10-12-11-40-26/english-video-reader/bench/es-test.wav';
const MODEL = process.env.MODEL || 'whisper-base';
const CDP_PORT = 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'echo-es-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const list = [target];
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const logs = []; const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
async function cmd(method, params) {
  const i = ++id;
  const m = await new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
  return m.result;
}
const ev = async (e) => {
  const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

await cmd('Runtime.enable');
await cmd('DOM.enable');
await cmd('Page.enable');
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
const out = {};

// 等应用启动
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
out.可选模型 = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#setAsrModel option')].map(o => o.value))`));

// 切到西语模型
out.切换模型 = await ev(`(function(){
  const s = document.getElementById('setAsrModel');
  if (![...s.options].some(o => o.value === '${MODEL}')) return 'not-in-list';
  s.value = '${MODEL}';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched';
})()`);

// 等模型装载（进度文本会变，状态会变「已就绪」）
let readyMs = null; const t0 = Date.now();
for (let i = 0; i < 400; i++) {
  const s = await ev(`document.getElementById('txtAsr')?.textContent || ''`);
  const p = await ev(`document.getElementById('progressText')?.textContent || ''`);
  if (/就绪/.test(s) && !p) { readyMs = Date.now() - t0; break; }
  await sleep(500);
}
out.模型装载耗时ms = readyMs;
out.asr状态 = await ev(`document.getElementById('txtAsr')?.textContent`);

// 导入西语音频
const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [AUDIO], nodeId: q.nodeId });

// 等字幕出现（识别 → 翻译）
const t1 = Date.now();
let cues = 0, en = 0, zh = 0;
for (let i = 0; i < 900; i++) {
  const s = JSON.parse(await ev(`JSON.stringify({
    n: document.querySelectorAll('#subs .cue').length,
    en: document.querySelectorAll('#subs .cue-en').length,
    zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
    to: document.getElementById('toast')?.textContent || '',
    busy: !!document.getElementById('btnTranscribe')?.disabled
  })`));
  cues = s.n; en = s.en; zh = s.zh;
  if (s.to && /失败|为空/.test(s.to)) { out.toast = s.to; break; }
  if (cues > 0 && zh >= cues && !s.busy) break;
  await sleep(700);
}
out.识别翻译耗时ms = Date.now() - t1;
out.句数 = cues;

// 取结果
out.结果 = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#subs .cue')].slice(0, 8).map(c => ({
    t: c.querySelector('.cue-time span')?.textContent,
    外文: c.querySelector('.cue-en')?.textContent.trim(),
    中文: c.querySelector('.cue-zh')?.textContent.trim()
  })), null, 1)`));
out.toast = out.toast || await ev(`document.getElementById('toast')?.textContent || ''`);
out.控制台 = logs.filter(l => /mt\]|asr-pool|西|es/i.test(l)).slice(0, 6);
out.异常 = errs.slice(0, 3);
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill("SIGKILL");
