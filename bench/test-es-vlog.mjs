// 阶段 8 验收：拿**真的西语 Vlog**（914MB / 370 秒 / 4K）走完整链路 ——
// 西语模式识别 → 西语原文 + 英文翻译 + 中文翻译 三行都落地。
//
//   node bench/test-es-vlog.mjs [httpPort] [cdpPort] [时长上限秒] [媒体路径]
//
// 和 bench/test-three-line.mjs 的区别：这个不喂 5 秒的 wav，喂一个 6 分 10 秒的
// 4K 视频。要过的关口多了：file.arrayBuffer() 得吞下 900+MB、
// OfflineAudioContext 得从 mp4 里把音轨解出来、静音切段要切出十几段、
// whisper 得跑几分钟、opus-mt 还得把上百句过两趟。所以这里全程打印进度，
// 好让后台跑的时候能看出它卡在哪一步。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9348);
const MAX_SEC = Number(process.argv[4] || 3600);
const MEDIA = process.argv[5] || '/Users/orion/Movies/西语Vlog｜我终于来到了巴塔哥尼亚.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// 固定 profile：whisper + opus-mt 加起来 300+MB，每跑一次都重下会拖到没法迭代
const profile = join(tmpdir(), 'echo-vlog-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900', 'about:blank',
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
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text;
      errs.push(String(d).split('\n')[0]);
    }
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
  const J = (expr) => ev(`JSON.stringify(${expr})`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');

  log('打开应用…');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 200; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

  const out = {};
  const ready = async (modelId, maxMs) => {
    const s0 = Date.now();
    while (Date.now() - s0 < maxMs) {
      const s = await J(`({ asr: document.getElementById('txtAsr')?.textContent || '', sel: document.getElementById('setAsrModel')?.value || '' })`);
      if (s.sel === modelId && /就绪|Ready|Listo/.test(s.asr)) return true;
      await sleep(500);
    }
    return false;
  };

  /* ── 1) 切西语模式 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(600);
  out['1_切西语后_弹窗'] = await ev(`!document.getElementById('askModal').hidden`);
  out['1_原文按钮标签'] = await ev(`document.querySelector('#langSeg button[data-lang="en"]')?.textContent.trim()`);
  const tModel = Date.now();
  out['1_西语模型就绪'] = await ready('whisper-base', 420000);
  out['1_模型就绪耗时ms'] = Date.now() - tModel;
  log('西语识别模型就绪:', out['1_西语模型就绪'], `${out['1_模型就绪耗时ms']}ms`);
  if (!out['1_西语模型就绪']) throw new Error('whisper-base 没能就绪，后续没法测');

  /* ── 2) 导入真视频 ── */
  const doc = await cmd('DOM.getDocument', { depth: 1 });
  const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
  const tImport = Date.now();
  log('导入视频:', MEDIA);
  await cmd('DOM.setFileInputFiles', { files: [MEDIA], nodeId: q.nodeId });

  // 等 <video> 认出时长（这一步就能证明 4K mp4 真的被拿起来了）
  let dur = 0;
  for (let i = 0; i < 240; i++) {
    const v = await J(`(() => { const p = document.getElementById('player'); return { d: p?.duration || 0, w: p?.videoWidth || 0, h: p?.videoHeight || 0 }; })()`);
    if (v.d > 0) { dur = v.d; out['2_视频'] = v; break; }
    if (i === 60) log('  …还在等视频元数据');
    if (i === 30 && await ev(`!document.getElementById('btnTranscribe').disabled && !document.getElementById('progressWrap').hidden === false`)) {
      log('  识别没自动开始，手动点一下');
      await ev(`document.getElementById('btnTranscribe').click()`);
    }
    await sleep(500);
  }
  log('视频元数据:', JSON.stringify(out['2_视频'] || null), `用时 ${((Date.now() - tImport) / 1000).toFixed(1)}s`);

  /* ── 3) 盯着进度跑到三行齐全 ── */
  const seen = [];
  let lastText = '';
  let settled = false;
  const deadline = Date.now() + MAX_SEC * 1000;
  let n = 0, mid = 0, zh = 0;
  while (Date.now() < deadline) {
    const s = await J(`({
      n: document.querySelectorAll('#subs .cue').length,
      mid: document.querySelectorAll('#subs .cue-mid:not(.pending)').length,
      zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
      txt: document.getElementById('progressText')?.textContent || '',
      pct: document.getElementById('progressBar')?.style.width || '0%',
      busy: !!document.getElementById('btnTranscribe')?.disabled,
      asr: document.getElementById('txtAsr')?.textContent || ''
    })`);
    n = s.n; mid = s.mid; zh = s.zh;
    const stamp = `${s.pct} ${s.txt}`;
    if (stamp !== lastText) {
      lastText = stamp;
      seen.push({ 秒: +((Date.now() - tImport) / 1000).toFixed(0), 进度: s.pct, 文字: s.txt.slice(0, 90) });
      log(`进度 ${s.pct} ${s.txt.slice(0, 90)}  句=${s.n} 英=${s.mid} 中=${s.zh} ${s.busy ? '(忙)' : ''}`);
    }
    if (n > 0 && mid >= n && zh >= n && !s.busy) { settled = true; break; }
    await sleep(1000);
  }
  out['3_三行就绪'] = settled;
  out['3_总耗时ms'] = Date.now() - tImport;
  out['3_进度轨迹'] = seen;
  log(`三行就绪=${settled} 句=${n} 英=${mid} 中=${zh} 总耗时 ${(out['3_总耗时ms'] / 1000).toFixed(1)}s`);

  /* ── 4) 取回结果 ── */
  out['4_句子'] = await J(`(
    [...document.querySelectorAll('#subs .cue')].map(c => ({
      原文: (c.querySelector('.cue-en')?.textContent || '').trim(),
      英文: (c.querySelector('.cue-mid')?.textContent || '').trim(),
      中文: (c.querySelector('.cue-zh')?.textContent || '').trim()
    }))
  )`);
  out['4_句数'] = out['4_句子'].length;
  out['4_前5句'] = out['4_句子'].slice(0, 5);
  out['4_末2句'] = out['4_句子'].slice(-2);
  out['4_电影时长秒'] = +(dur || 0).toFixed(2);

  /* ── 5) 三个开关在真字幕上也得好使 ── */
  const clickSeg = async (lang) => {
    await ev(`document.querySelector('#langSeg button[data-lang="${lang}"]').click()`);
    await sleep(300);
    return J(`[...document.getElementById('subs').classList]`);
  };
  out['5_关英文'] = await clickSeg('mid');
  out['5_关原文'] = await clickSeg('en');
  out['5_关中文'] = await clickSeg('zh');
  await clickSeg('mid'); await clickSeg('en'); await clickSeg('zh');
  out['5_全开'] = await J(`[...document.getElementById('subs').classList]`);

  out['异常'] = errs.slice(0, 5);
  console.log('\n=== 结果 ===');
  console.log(JSON.stringify(out, null, 1));

  /* ── 判定 ── */
  const dense = (s) => s.replace(/\s+/g, '');
  const cjk = (s) => { const d = dense(s); return d ? (d.match(/[\u4e00-\u9fff]/g) || []).length / d.length : 0; };
  const ES_STOP = /\b(que|de|la|el|en|y|a|los|las|se|es|un|una|por|con|para|su|al|lo|como|más|pero|todo|esta|este|muy|ya|no|del|hay|fue|ser|está|aquí|nos|me|te|mi|si|también)\b/i;
  const EN_STOP = /\b(the|to|and|of|is|it|in|you|that|was|for|on|are|with|as|at|be|this|have|from|or|an|we|they|I)\b/i;
  const sents = out['4_句子'] || [];
  const allThree = sents.length > 0 && sents.every((s) => s.原文 && s.英文 && s.中文);
  // 西语原文：带西语重音/ñ/¿¡，或者命中西语虚词
  const srcEs = sents.filter((s) => /[áéíóúñü¿¡]/i.test(s.原文) || ES_STOP.test(s.原文)).length;
  // 英文那行不能是中文，也不能还是西语原样（要有英文虚词）
  const midEn = sents.filter((s) => cjk(s.英文) < 0.05 && EN_STOP.test(s.英文)).length;
  const zhCn = sents.filter((s) => cjk(s.中文) > 0.3).length;
  const pctOf = (k) => sents.length ? +(k / sents.length * 100).toFixed(1) : 0;
  const quality = {
    句数: sents.length,
    '原文像西语%': pctOf(srcEs),
    '英文行像英语%': pctOf(midEn),
    '中文行像中文%': pctOf(zhCn),
    时长秒: out['4_电影时长秒'],
    '总耗时秒': +(out['3_总耗时ms'] / 1000).toFixed(1),
  };
  console.log('\n=== 质量 ===');
  console.log(JSON.stringify(quality, null, 1));

  const cl = (k) => out[k] || [];
  const checks = {
    '视频真的是那个 4K Vlog（时长 ≈370s、宽 3840）': Math.abs(out['4_电影时长秒'] - 369.84) < 3 && (out['2_视频']?.w || 0) >= 1920,
    '西语模式下没有弹「要重新识别吗」': out['1_切西语后_弹窗'] === false,
    '原文按钮标签是「西语」': out['1_原文按钮标签'] === '西语',
    '三行全部落地（每句原文/英文/中文都非空且不 pending）': out['3_三行就绪'] === true && allThree,
    '句子数量像一段 6 分钟的口播（≥ 30 句）': sents.length >= 30,
    '原文行确实是西语（≥ 80% 的句子带重音或西语虚词）': pctOf(srcEs) >= 80,
    '英文行确实是英语（≥ 80% 无汉字且有英文虚词）': pctOf(midEn) >= 80,
    '中文行确实是中文（≥ 95% 汉字占比 > 0.3）': pctOf(zhCn) >= 95,
    '关英译文只藏中间那行': cl('5_关英文').includes('hide-mid') && !cl('5_关英文').includes('hide-en'),
    '关原文只藏原文那行': cl('5_关原文').includes('hide-en') && !cl('5_关原文').includes('hide-zh'),
    '关中文只藏中文那行': cl('5_关中文').includes('hide-zh'),
    '三个开关都恢复得回来': !cl('5_全开').includes('hide-mid') && !cl('5_全开').includes('hide-en') && !cl('5_全开').includes('hide-zh') && !cl('5_全开').includes('bare'),
    '无 JS 异常': errs.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n判定：');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  console.log(failed.length ? `\n✗ 西语 Vlog 端到端没通过：${failed.join(' / ')}` : '\n✓ 西语 Vlog 端到端全部通过');
  ok = failed.length === 0;
  ws.close();
} catch (e) {
  console.error('跑挂了:', e?.message || e);
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
