// 学习语言模式（左上角 English / Español）验证。
//   node bench/test-mode.mjs [httpPort]
// 需要一个已在跑的静态服务器（tools/serve.py），默认端口 8910。
//
// 验五件事：
//   1. 模式按钮存在、默认高亮 English、识别模型是 whisper-base.en
//   2. 它跟界面语言**互不干扰**（界面切西语，模式与模型都不动）
//   3. 点 Español → 真的换成多语言模型 whisper-base，存档 mode='es'
//   4. 点回 English → 换回 whisper-base.en
//   5. 顶栏没被这个新按钮挤到溢出
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9338);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'echo-mode-'));
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
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

  const out = {};
  const snap = () => ev(`JSON.stringify({
    模式按钮: [...document.querySelectorAll('#modeSeg button')].map(b => b.dataset.mode + (b.classList.contains('active') ? '*' : '')),
    模式提示: [...document.querySelectorAll('#modeSeg button')].map(b => b.title),
    识别模型: document.getElementById('setAsrModel')?.value,
    界面语言: document.documentElement.lang,
    brand: document.querySelector('.brand .sub')?.textContent.trim(),
    存档: (() => { try { const s = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}'); return { mode: s.mode, asrModel: s.asrModel }; } catch (e) { return String(e); } })()
  })`).then(JSON.parse);

  const probe = () => ev(`JSON.stringify({
    asr: document.getElementById('txtAsr')?.textContent || '',
    sel: document.getElementById('setAsrModel')?.value || '',
    prog: document.getElementById('progressWrap')?.hidden === false
  })`).then(JSON.parse);

  /** 等到「这个识别模型」真的就绪。光看「就绪」两个字不够：
   *  切模型的一瞬间旧模型还是就绪态，抢在前面就会误判成已经切好了。 */
  const waitReadyFor = async (modelId, maxMs) => {
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = await probe();
      if (!seen.length || seen[seen.length - 1] !== s.asr) seen.push(s.asr);
      if (!s.prog && s.sel === modelId && /就绪|Ready|Listo/.test(s.asr)) return { ok: true, seen };
      await sleep(400);
    }
    return { ok: false, seen };
  };

  /* ── 1) 默认态 ── */
  await sleep(600);
  out['1_默认'] = await snap();

  /* ── 2) 与界面语言互不干扰 ── */
  const setUILang = async (l) => {
    await ev(`(function(){ const s=document.getElementById('setLang'); s.value='${l}'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await sleep(600);
  };
  await setUILang('es');
  out['2_界面切西语后'] = await snap();
  await setUILang('en');
  out['2b_界面切英语后'] = await snap();
  await setUILang('zh');
  await sleep(400);

  /* ── 3) 点 Español ── */
  const readyEn = await waitReadyFor('whisper-base.en', 300000);
  out['3a_初始英语就绪'] = readyEn.ok;
  out['3a_状态变化'] = readyEn.seen;

  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  out['3b_点击后立刻'] = await probe();          // 应该已经是「正在预热」而不是 ready
  const t1 = Date.now();
  const readyEs = await waitReadyFor('whisper-base', 300000);
  out['3c_西语模型就绪'] = readyEs.ok;
  out['3c_状态变化'] = readyEs.seen;
  out['3c_切换耗时ms'] = Date.now() - t1;
  out['3c_点击Español后'] = await snap();
  out['3c_模型说明'] = await ev(`document.getElementById('asrModelNote')?.textContent?.slice(0, 70)`);

  /* ── 4) 点回 English ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  const t2 = Date.now();
  const readyEn2 = await waitReadyFor('whisper-base.en', 300000);
  out['4_英语模型就绪'] = readyEn2.ok;
  out['4_切换耗时ms'] = Date.now() - t2;
  out['4_点击English后'] = await snap();

  /* ── 5) 顶栏布局 ── */
  out['5_布局'] = JSON.parse(await ev(`JSON.stringify((() => {
    const bar = document.querySelector('.topbar');
    const seg = document.getElementById('modeSeg');
    const r = seg.getBoundingClientRect();
    return {
      窗口宽: window.innerWidth,
      顶栏scrollW: bar.scrollWidth, 顶栏clientW: bar.clientWidth,
      模式块宽: Math.round(r.width), 模式块右边缘: Math.round(r.right),
      按钮尺寸: [...seg.querySelectorAll('button')].map(b => { const q = b.getBoundingClientRect(); return Math.round(q.width) + 'x' + Math.round(q.height); }),
      水平溢出元素: [...document.querySelectorAll('.topbar *')].filter(n => n.getBoundingClientRect().right > window.innerWidth + 1).map(n => n.className || n.id).slice(0, 5)
    };
  })())`));

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  const pass = out['1_默认'].模式按钮.join() === 'en*,es'
    && out['1_默认'].识别模型 === 'whisper-base.en'
    && out['2_界面切西语后'].模式按钮.join() === 'en*,es'
    && out['2_界面切西语后'].识别模型 === 'whisper-base.en'
    && out['3c_点击Español后'].模式按钮.join() === 'en,es*'
    && out['3c_点击Español后'].识别模型 === 'whisper-base'
    && out['3c_点击Español后'].存档.mode === 'es'
    && out['3c_点击Español后'].存档.asrModel === 'whisper-base'
    && readyEs.ok
    && out['4_点击English后'].模式按钮.join() === 'en*,es'
    && out['4_点击English后'].识别模型 === 'whisper-base.en'
    && out['5_布局'].水平溢出元素.length === 0
    && errs.length === 0;
  console.log(pass ? '\n✓ 模式开关全部通过' : '\n✗ 模式开关有问题，见上面 JSON');
  ok = pass;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
