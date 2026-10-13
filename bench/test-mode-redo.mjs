// 阶段 3 验证：已有字幕时切换学习语言模式，要先问「要不要重新识别」。
//   node bench/test-mode-redo.mjs [httpPort] [cdpPort]
//
// 用 bench/en-test.wav（英语语音，2 句）走一遍真实流程：
//   英语识别 → 点 Español → 弹窗 → 取消（只切模式、不动字幕）
//   → 切回 English（不该弹窗）→ 再切 Español → 确认（真的重跑识别）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9339);
const AUDIO = new URL('./en-test.wav', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'echo-redo-'));
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
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

  const out = {};
  const state = () => ev(`JSON.stringify({
    模式: [...document.querySelectorAll('#modeSeg button')].find(b => b.classList.contains('active'))?.dataset.mode,
    识别模型: document.getElementById('setAsrModel')?.value,
    弹窗可见: !document.getElementById('askModal')?.hidden,
    弹窗标题: document.getElementById('askTitle')?.textContent,
    弹窗正文: document.getElementById('askBody')?.textContent,
    弹窗按钮: [document.getElementById('askOk')?.textContent, document.getElementById('askCancel')?.textContent],
    字幕数: document.querySelectorAll('#subs .cue').length,
    首句: document.querySelector('#subs .cue .cue-en')?.textContent?.trim(),
    短片: window.__progSeen || 0
  })`).then(JSON.parse);

  const ready = async (modelId, maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = JSON.parse(await ev(`JSON.stringify({
        asr: document.getElementById('txtAsr')?.textContent || '',
        sel: document.getElementById('setAsrModel')?.value || ''
      })`));
      if (s.sel === modelId && /就绪|Ready|Listo/.test(s.asr)) return true;
      await sleep(400);
    }
    return false;
  };

  await ready('whisper-base.en', 300000);

  // 装一个「进度条出现过几次」的计数器 —— 重跑识别一定会亮进度条
  await ev(`(function(){
    window.__progSeen = 0;
    const p = document.getElementById('progressWrap');
    new MutationObserver(() => { if (!p.hidden) window.__progSeen++; })
      .observe(p, { attributes: true, attributeFilter: ['hidden'] });
    return 1;
  })()`);

  // 导入英语音频并等识别 + 翻译完成
  const doc = await cmd('DOM.getDocument', { depth: 1 });
  const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
  await cmd('DOM.setFileInputFiles', { files: [AUDIO], nodeId: q.nodeId });
  for (let i = 0; i < 900; i++) {
    const s = JSON.parse(await ev(`JSON.stringify({
      n: document.querySelectorAll('#subs .cue').length,
      zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
      busy: !!document.getElementById('btnTranscribe')?.disabled
    })`));
    if (s.n > 0 && s.zh >= s.n && !s.busy) break;
    await sleep(600);
  }
  out['1_英语识别完'] = await state();

  /* ── 2) 点 Español：应该弹窗，且**先不切**模型 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(500);
  out['2_点Español后'] = await state();

  /* ── 3) 取消：模式切过去，字幕原样不动 ── */
  await ev(`document.getElementById('askCancel').click()`);
  await ready('whisper-base', 300000);
  await sleep(500);
  out['3_取消后'] = await state();

  /* ── 4) 切回 English：recogLang 还是 en，不该再弹窗 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  await sleep(500);
  out['4_切回英语'] = await state();
  await ready('whisper-base.en', 300000);

  /* ── 5) 再点 Español，这次确认：应该真的重跑识别 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(400);
  out['5_再点Español'] = await state();
  await ev(`document.getElementById('askOk').click()`);
  // 等进度条亮起来（= 重跑真的开始了）
  let started = false;
  for (let i = 0; i < 120; i++) {
    if ((await ev(`window.__progSeen || 0`)) > 0) { started = true; break; }
    await sleep(400);
  }
  out['5_重跑已开始'] = started;
  await ready('whisper-base', 300000);
  for (let i = 0; i < 900; i++) {
    const s = JSON.parse(await ev(`JSON.stringify({
      n: document.querySelectorAll('#subs .cue').length,
      busy: !!document.getElementById('btnTranscribe')?.disabled
    })`));
    if (s.n > 0 && !s.busy) break;
    await sleep(600);
  }
  out['5_重跑后'] = await state();

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  const pass = out['1_英语识别完'].模式 === 'en'
    && out['1_英语识别完'].字幕数 > 0
    && out['2_点Español后'].弹窗可见 === true
    && out['2_点Español后'].模式 === 'en'          // 还没确认，模式不能先动
    && /重新识别|Transcribe again|Volver a transcribir/.test(out['2_点Español后'].弹窗按钮[0] || '')
    && out['3_取消后'].模式 === 'es'
    && out['3_取消后'].识别模型 === 'whisper-base'
    && out['3_取消后'].弹窗可见 === false
    && out['3_取消后'].首句 === out['1_英语识别完'].首句   // 字幕没被动过
    && out['4_切回英语'].弹窗可见 === false
    && out['4_切回英语'].识别模型 === 'whisper-base.en'
    && out['5_再点Español'].弹窗可见 === true
    && out['5_重跑已开始'] === true
    && out['5_重跑后'].模式 === 'es'
    && out['5_重跑后'].识别模型 === 'whisper-base'
    && out['5_重跑后'].字幕数 > 0
    && errs.length === 0;
  console.log(pass ? '\n✓ 切模式确认流程全部通过' : '\n✗ 切模式确认流程有问题');
  ok = pass;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
