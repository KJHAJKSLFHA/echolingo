// 阶段 4 验证：西语模式下字幕出三行（西语原文 / 英文翻译 / 中文），
// 三个开关（原文·英文·中文）都能独立收起，英语模式下中间那行不出现。
//   node bench/test-three-line.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9340);
const AUDIO = new URL('./es-test.wav', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用固定目录而不是 mkdtemp：模型有 100+ MB，每次都换新 profile 等于每跑一次
// 都从 HTTP 服务重新下一遍，迭代一次要十几分钟。
const profile = join(tmpdir(), 'echo-3line-profile');
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
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

  const out = {};
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
  const segState = () => ev(`JSON.stringify({
    按钮: [...document.querySelectorAll('#langSeg button')].map(b => ({
      语言: b.dataset.lang, 文字: b.textContent.trim(), 隐藏: b.hidden, 高亮: b.classList.contains('active')
    })),
    原文按钮标签: document.querySelector('#langSeg button[data-lang="en"]')?.textContent.trim(),
    subs类: [...document.getElementById('subs').classList],
    提示条隐藏: document.getElementById('bareHint')?.hidden
  })`).then(JSON.parse);

  /* ── 1) 切到西语模式（此时还没字幕，不该弹窗）── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(600);
  out['1_切西语后'] = { 弹窗: await ev(`!document.getElementById('askModal').hidden`), ...(await segState()) };
  out['1_模型就绪'] = await ready('whisper-base', 300000);

  /* ── 2) 导入西语音频，等三行都落地 ── */
  const doc = await cmd('DOM.getDocument', { depth: 1 });
  const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
  await cmd('DOM.setFileInputFiles', { files: [AUDIO], nodeId: q.nodeId });

  let settled = false;
  for (let i = 0; i < 1200; i++) {
    const s = JSON.parse(await ev(`JSON.stringify({
      n: document.querySelectorAll('#subs .cue').length,
      mid: document.querySelectorAll('#subs .cue-mid:not(.pending)').length,
      zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
      busy: !!document.getElementById('btnTranscribe')?.disabled
    })`));
    if (s.n > 0 && s.mid >= s.n && s.zh >= s.n && !s.busy) { settled = true; break; }
    await sleep(700);
  }
  out['2_三行就绪'] = settled;

  out['2_句子'] = JSON.parse(await ev(`JSON.stringify(
    [...document.querySelectorAll('#subs .cue')].map(c => ({
      原文: c.querySelector('.cue-en')?.textContent.trim() || '',
      英文: c.querySelector('.cue-mid')?.textContent.trim() || '',
      中文: c.querySelector('.cue-zh')?.textContent.trim() || ''
    }))
  )`));

  /* ── 3) 三个开关各自 Independent ── */
  const clickSeg = async (lang) => {
    await ev(`document.querySelector('#langSeg button[data-lang="${lang}"]').click()`);
    await sleep(250);
    return segState();
  };
  out['3_关英文翻译'] = await clickSeg('mid');
  out['3_关原文'] = await clickSeg('en');
  out['3_关中文'] = await clickSeg('zh');
  out['3_全打开1'] = await clickSeg('mid');
  out['3_全打开2'] = await clickSeg('en');
  out['3_全打开3'] = await clickSeg('zh');

  /* ── 4) 切回英语模式并确认重识别：中文重来，中间那行消失、按钮藏起来 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  await sleep(600);
  out['4_弹窗'] = await ev(`!document.getElementById('askModal').hidden`);
  await ev(`document.getElementById('askOk').click()`);
  await ready('whisper-base.en', 300000);
  let englishDone = false;
  for (let i = 0; i < 1200; i++) {
    const s = JSON.parse(await ev(`JSON.stringify({
      n: document.querySelectorAll('#subs .cue').length,
      mid: document.querySelectorAll('#subs .cue-mid').length,
      zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
      busy: !!document.getElementById('btnTranscribe')?.disabled
    })`));
    if (s.n > 0 && s.mid === 0 && s.zh >= s.n && !s.busy) { englishDone = true; break; }
    await sleep(700);
  }
  out['4_英语重识别完成'] = englishDone;
  out['4_切回英语'] = await segState();
  out['4_英语句子'] = JSON.parse(await ev(`JSON.stringify(
    [...document.querySelectorAll('#subs .cue')].map(c => c.querySelector('.cue-en')?.textContent.trim() || '')
  )`));

  /* ── 5) 英语模式下字幕后端不该出现 cue-mid 元素 ── */
  out['5_英语模式有mid元素'] = await ev(`document.querySelectorAll('#subs .cue-mid').length`);

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  const cjkRatio = (s) => {
    const dense = s.replace(/\s+/g, '');
    if (!dense) return 0;
    return (dense.match(/[\u4e00-\u9fff]/g) || []).length / dense.length;
  };
  const sents = out['2_句子'] || [];
  const allThree = sents.length > 0 && sents.every((s) => s.原文 && s.英文 && s.中文);
  const midIsEnglish = sents.every((s) => cjkRatio(s.英文) < 0.1);
  const zhIsChinese = sents.every((s) => cjkRatio(s.中文) > 0.3);
  // 西语原文：至少有一句带重音/ñ，或者不是纯 ASCII 英文
  const srcLooksSpanish = sents.some((s) => /[áéíóúñü¿¡]/i.test(s.原文));
  const cls = (k) => out[k].subs类;
  const pass = out['1_切西语后'].弹窗 === false
    && out['1_模型就绪'] === true
    && out['1_切西语后'].原文按钮标签 === '西语'
    && out['1_切西语后'].按钮.length === 3
    && out['1_切西语后'].按钮.find((b) => b.语言 === 'mid').隐藏 === false
    && out['2_三行就绪'] === true
    && allThree && midIsEnglish && zhIsChinese && srcLooksSpanish
    && cls('3_关英文翻译').includes('hide-mid') && !cls('3_关英文翻译').includes('hide-en')
    && cls('3_关原文').includes('hide-en') && !cls('3_关原文').includes('hide-zh')
    && cls('3_关中文').includes('hide-zh') && cls('3_关中文').includes('bare')
    && !cls('3_全打开3').includes('hide-mid')
    && !cls('3_全打开3').includes('hide-en')
    && !cls('3_全打开3').includes('hide-zh')
    && !cls('3_全打开3').includes('bare')
    && out['4_弹窗'] === true
    && out['4_英语重识别完成'] === true
    && out['4_切回英语'].原文按钮标签 === '英文'
    && out['4_切回英语'].按钮.find((b) => b.语言 === 'mid').隐藏 === true
    && out['5_英语模式有mid元素'] === 0
    && errs.length === 0;
  console.log(pass ? '\n✓ 三语字幕全部通过' : '\n✗ 三语字幕有问题');
  ok = pass;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
