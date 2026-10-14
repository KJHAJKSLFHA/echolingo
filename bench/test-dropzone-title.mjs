// 拖拽区标题按学习模式切换：英文模式说「拖英语视频」，西语模式说「拖西班牙语视频」。
// 顺带核对界面语言切到 en/es 时标题也跟着翻译，以及回到英语模式后文案复原。
//   node bench/test-dropzone-title.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9365);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), 'echo-dz-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let ok = false;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  const cmd = async (method, params) => {
    const i = ++id;
    const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
    return m.result;
  };
  const ev = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');
  // 先开一次 about:blank 把界面语言钉死成中文：i18n 的 detect() 会先读
  // localStorage['echolingo.lang']，读不到才看 navigator.language。不钉的话，
  // 复用 profile 时初始语言取决于上一次跑完停在哪一档，断言会随机偏移。
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  await sleep(1500);
  await ev(`localStorage.setItem('echolingo.lang', 'zh')`);
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
  const startLang = await ev(`document.documentElement.lang`);
  if (startLang !== 'zh-CN') throw new Error('界面语言没被钉成中文，实际 = ' + startLang);

  const out = {};
  // 注意：切到西语模式后 dataset.i18n 会变成 dz.titleEs，所以选择器不能写死
  // [data-i18n="dz.title"]，要用前缀匹配把两种 key 都圈进来。
  const dzState = () => ev(`JSON.stringify({
    标题: document.querySelector('[data-i18n^="dz.title"]')?.textContent.trim() || '',
    绑定key: document.querySelector('[data-i18n^="dz.title"]')?.dataset.i18n || '',
    模式: document.querySelector('#modeSeg button.active')?.dataset.mode || ''
  })`).then(JSON.parse);

  /* ── 1) 默认英语模式 + 中文界面 ── */
  out['1_英语模式中文界面'] = await dzState();

  /* ── 2) 切西语模式 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(400);
  out['2_西语模式中文界面'] = await dzState();

  /* ── 3) 界面语言 zh → en（模式仍是西语）── */
  await ev(`document.querySelector('#btnLang').click()`);
  await sleep(300);
  out['3_西语模式英文界面'] = { 界面语言: await ev(`document.documentElement.lang`), ...(await dzState()) };

  /* ── 4) 界面语言 en → es ── */
  await ev(`document.querySelector('#btnLang').click()`);
  await sleep(300);
  out['4_西语模式西语界面'] = { 界面语言: await ev(`document.documentElement.lang`), ...(await dzState()) };

  /* ── 5) 切回英语模式（此时无字幕，不该弹重识别窗）── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  await sleep(400);
  out['5_切回英语模式'] = { 弹窗: await ev(`!document.getElementById('askModal').hidden`), ...(await dzState()) };

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  // 界面语言循环是 zh → en → es，前一步是西语模式，所以：
  //   英语模式 + zh 界面 → 中文文案
  //   西语模式 + zh 界面 → 中文文案（切模式时 applyModeView 会重刷）
  //   西语模式 + en 界面 → 英文文案（applyI18n 按 dataset.i18n 重刷）
  //   西语模式 + es 界面 → 西语文案
  //   切回英语模式后 dataset.i18n 回到 dz.title，界面语言仍是 es → 西语文案
  const s1 = out['1_英语模式中文界面'], s2 = out['2_西语模式中文界面'];
  const s3 = out['3_西语模式英文界面'], s4 = out['4_西语模式西语界面'];
  const s5 = out['5_切回英语模式'];
  const pass = s1.模式 === 'en' && s1.绑定key === 'dz.title' && s1.标题 === '把英语视频拖进来'
    && s2.模式 === 'es' && s2.绑定key === 'dz.titleEs' && s2.标题 === '把西班牙语视频拖进来'
    && s3.界面语言 === 'en' && s3.模式 === 'es' && s3.绑定key === 'dz.titleEs' && s3.标题 === 'Drop a Spanish video here'
    && s4.界面语言 === 'es' && s4.模式 === 'es' && s4.绑定key === 'dz.titleEs' && s4.标题 === 'Arrastra aquí tu vídeo en español'
    && s5.弹窗 === false && s5.模式 === 'en' && s5.绑定key === 'dz.title' && s5.标题 === 'Arrastra aquí tu vídeo en inglés'
    && errs.length === 0;
  console.log(pass ? '\n✓ 拖拽区标题按模式切换全部通过' : '\n✗ 拖拽区标题有问题');
  ok = pass;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
