// 西语完整验证：界面切西语（检查缺词）+ 西语识别 + es→en→zh 翻译。
// usage: node bench/test-spanish-full.mjs [httpPort]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const AUDIO = '/Users/orion/WorkBuddy/2026-10-12-11-40-26/english-video-reader/bench/es-test.wav';
const CDP_PORT = 9335;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'echo-esfull-'));
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
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
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
await cmd('Page.navigate', { url: `https://echolingo-reader.netlify.app/app/` });
const out = {};
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

/* ── 1) 界面语言：逐个切三种，检查有没有漏翻的 key ── */
const scan = async (lang) => {
  await ev(`(function(){ const s=document.getElementById('setLang'); s.value='${lang}'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
  await sleep(500);
  return JSON.parse(await ev(`JSON.stringify({
    lang: document.documentElement.lang,
    存档: localStorage.getItem('echolingo.lang'),
    按钮上的下一个: document.getElementById('langLabel')?.textContent,
    标题: document.title,
    // t() 找不到词条时会原样返回 key —— 出现「xx.yy」形状的文本就说明漏了
    漏翻样本: [...document.querySelectorAll('[data-i18n]')]
      .map(n => n.textContent.trim())
      .filter(s => /^[a-z]+\\.[A-Za-z.]+$/.test(s)).slice(0, 8)
  })`) );
};
out.界面_zh = await scan('zh');
out.界面_en = await scan('en');
out.界面_es = await scan('es');

/* ── 2) 西语识别 + 翻译 ── */
await ev(`(function(){ const s=document.getElementById('setAsrModel'); s.value='whisper-base'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
for (let i = 0; i < 400; i++) {
  const s = await ev(`document.getElementById('txtAsr')?.textContent || ''`);
  const p = await ev(`document.getElementById('progressText')?.textContent || ''`);
  if (/listo|就绪/.test(s) && !p) break;
  await sleep(500);
}
out.模型 = await ev(`document.getElementById('txtAsr')?.textContent`);

const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [AUDIO], nodeId: q.nodeId });

const t1 = Date.now();
let cues = 0;
for (let i = 0; i < 900; i++) {
  const s = JSON.parse(await ev(`JSON.stringify({
    n: document.querySelectorAll('#subs .cue').length,
    zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
    busy: !!document.getElementById('btnTranscribe')?.disabled
  })`));
  cues = s.n;
  if (cues > 0 && s.zh >= cues && !s.busy) break;
  await sleep(700);
}
out.识别翻译耗时ms = Date.now() - t1;
out.结果 = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#subs .cue')].map(c => ({
    外文: c.querySelector('.cue-en')?.textContent.trim(),
    中文: c.querySelector('.cue-zh')?.textContent.trim()
  })), null, 1)`));
out.异常 = errs.slice(0, 3);
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill('SIGKILL');
