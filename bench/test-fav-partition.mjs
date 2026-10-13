// 阶段 6 验证：收藏按模式分区
//   ① 西语模式存一个西语词 + 一句西语 → 只有西语档有
//   ② 切到英语模式存英语词 + 英语句 → 英语档 2 条、西语档不受影响
//   ③ 切回西语模式：角标当场变回 2，抽屉里还是原来那两条（没被覆盖 / 没丢）
//   ④ 顶部标签仍然只有「生词 / 句子」两个
//   ⑤ 西语收藏的主键带 es: 前缀（不会被英语里的同形词覆盖）
//   node bench/test-fav-partition.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9344);
const ES_AUDIO = new URL('./es-test.wav', import.meta.url).pathname;
const EN_AUDIO = new URL('./en-test.wav', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), 'echo-favprofile');
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
  // 注意：expr 里可能有 Promise（比如读 IndexedDB）。
  // 直接 JSON.stringify(promise) 只会得到 "{}" —— 必须 await 出来再序列化。
  const J = (expr) => ev(`(async () => JSON.stringify(await (${expr})))()`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');

  const boot = async () => {
    await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
    for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
    await sleep(500);
  };
  await boot();

  /* ── 0) 清空收藏库，保证从零开始 ── */
  await ev(`new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words', 'sentences'], 'readwrite');
      tx.objectStore('words').clear();
      tx.objectStore('sentences').clear();
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => res(false);
    };
    rq.onerror = () => res(false);
  })`);
  // 模式也复位成英语（存档可能留着上一轮的西语）
  await ev(`(() => { const k = 'echolingo.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    s.mode = 'en'; s.asrModel = 'whisper-base.en';
    localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await boot();

  const out = {};
  const ready = async (modelId, maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = await J(`({ asr: document.getElementById('txtAsr')?.textContent || '', sel: document.getElementById('setAsrModel')?.value || '' })`);
      if (s.sel === modelId && /就绪|Ready|Listo/.test(s.asr)) return true;
      await sleep(400);
    }
    return false;
  };
  const importFile = async (file) => {
    const doc = await cmd('DOM.getDocument', { depth: 1 });
    const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
    await cmd('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  };
  const waitCues = async (wantMid, maxMs = 600000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = await J(`({
        n: document.querySelectorAll('#subs .cue').length,
        mid: document.querySelectorAll('#subs .cue-mid').length,
        zh: document.querySelectorAll('#subs .cue-zh:not(.pending)').length,
        busy: !!document.getElementById('btnTranscribe')?.disabled
      })`);
      if (s.n > 0 && s.zh >= s.n && !s.busy && (wantMid ? s.mid >= s.n : s.mid === 0)) return true;
      await sleep(700);
    }
    return false;
  };
  const favWord = async (preferAccent) => {
    const w = await ev(`(() => {
      const ws = [...document.querySelectorAll('#subs .cue-en .w')];
      const pick = ${preferAccent}
        ? (ws.find((x) => /[áéíóúüñ]/i.test(x.textContent)) || ws[0])
        : ws[0];
      if (!pick) return '';
      pick.click();
      return pick.textContent.trim();
    })()`);
    if (!w) return '';
    for (let i = 0; i < 200; i++) {
      if (await ev(`document.getElementById('wcBody').textContent.trim().length > 0`)) break;
      await sleep(500);
    }
    await ev(`document.getElementById('wcFav').click()`);
    await sleep(500);
    await ev(`document.getElementById('wcClose').click()`);
    await sleep(300);
    return w;
  };
  const favSentence = async () => {
    const t = await ev(`(() => {
      const b = document.querySelector('#subs .cue button[data-act="fav"]');
      if (!b) return '';
      b.click();
      return b.closest('.cue').querySelector('.cue-en').textContent.trim().slice(0, 50);
    })()`);
    await sleep(500);
    return t;
  };
  const readTab = () => J(`({
    徽标: document.getElementById('favCount').textContent.trim(),
    说明: document.getElementById('favScope').textContent.trim(),
    标签: [...document.querySelectorAll('#favSeg button')].map((b) => b.textContent.trim()),
    生词: [...document.querySelectorAll('#favBody .fav-item .t')].map((x) => x.textContent.trim()),
    句子: [...document.querySelectorAll('#favBody .fav-item .en')].map((x) => x.textContent.trim()),
    句子有英文行: document.querySelectorAll('#favBody .fav-item .mid').length
  })`);
  const favState = async () => {
    const wasHidden = await ev(`document.getElementById('favDrawer').hidden`);
    if (wasHidden) { await ev(`document.querySelector('#btnFavs').click()`); await sleep(450); }
    // 默认停在「生词」页，两个页签都要读一遍
    await ev(`document.querySelector('#favSeg button[data-tab="words"]').click()`);
    await sleep(200);
    const st = await readTab();
    await ev(`document.querySelector('#favSeg button[data-tab="sentences"]').click()`);
    await sleep(200);
    st.句子 = (await readTab()).句子;
    st.句子有英文行 = (await readTab()).句子有英文行;
    await ev(`document.querySelector('#favSeg button[data-tab="words"]').click()`);
    await sleep(200);
    await ev(`document.getElementById('favClose').click()`);
    await sleep(300);
    return st;
  };
  const badge = () => ev(`document.getElementById('favCount').textContent.trim()`);
  const readDB = () => J(`new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words', 'sentences'], 'readonly');
      const a = tx.objectStore('words').getAll();
      const b = tx.objectStore('sentences').getAll();
      tx.oncomplete = () => {
        db.close();
        res({
          词: a.result.map((w) => ({ id: w.id, word: w.word, lang: w.lang || '' })),
          句: b.result.map((s) => ({ id: s.id, lang: s.lang || '', en: (s.en || '').slice(0, 30) }))
        });
      };
    };
    rq.onerror = () => res({ 词: [], 句: [] });
  })`);

  /* ── 1) 西语档：存一个西语词 + 一句西语 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(600);
  out['1_西语模型就绪'] = await ready('whisper-base', 300000);
  await importFile(ES_AUDIO);
  out['1_字幕就绪'] = await waitCues(true);
  out['1_存的词'] = await favWord(true);
  out['1_存的句'] = await favSentence();
  out['1_抽屉'] = await favState();

  /* ── 2) 英语档：切模式（取消重识别）+ 导英语音频，再存两条 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  await sleep(600);
  out['2_弹窗'] = await ev(`!document.getElementById('askModal').hidden`);
  await ev(`document.getElementById('askCancel').click()`);
  out['2_英语模型就绪'] = await ready('whisper-base.en', 300000);
  await importFile(EN_AUDIO);
  out['2_字幕就绪'] = await waitCues(false);
  out['2_存的词'] = await favWord(false);
  out['2_存的句'] = await favSentence();
  out['2_抽屉'] = await favState();

  /* ── 3) 切回西语：角标当场变回 2，抽屉里还是原来那两条 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(600);
  if (await ev(`!document.getElementById('askModal').hidden`)) {
    await ev(`document.getElementById('askCancel').click()`);
  }
  await sleep(600);
  out['3_切回西语徽标'] = await badge();
  out['3_切回西语说明'] = await ev(`document.getElementById('favScope').textContent.trim()`);
  out['3_抽屉'] = await favState();
  out['3_数据库'] = await readDB();

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  /* ── 判定 ── */
  const d1 = out['1_抽屉'] || {}, d2 = out['2_抽屉'] || {}, d3 = out['3_抽屉'] || {};
  const db = { 词: [], 句: [], ...(out['3_数据库'] || {}) };
  const esWordId = `es:${out['1_存的词']}`;
  // 字幕上抓到的 token 带原样大小写（Welcome），但入库前 normalizeWord 会小写化
  const enWord = String(out['2_存的词'] || '').toLowerCase();
  // 「存的句」只截了前 50 字，而列表里是整句 → 用 startsWith 比，别拿 includes 当子串用
  const sentHead = (s) => String(s || '').slice(0, 20);
  const hasSent = (list, head) => (list || []).some((s) => s.startsWith(sentHead(head)));

  const checks = {
    '1 西语识别完成': out['1_西语模型就绪'] === true && out['1_字幕就绪'] === true,
    '1 西语档 2 条（词+句）': d1.徽标 === '2' && d1.生词.length === 1 && d1.句子.length === 1,
    '1 存进去的是西语词': d1.生词[0] === out['1_存的词'],
    '1 西语说明标注为西语': /西语收藏/.test(d1.说明 || ''),
    '1 顶部仍只有生词/句子两个标签': Array.isArray(d1.标签) && d1.标签.length === 2,
    '2 英语档 2 条（词+句）': d2.徽标 === '2' && d2.生词.length === 1 && d2.句子.length === 1,
    '2 英语档里看不到西语那两条': d2.生词[0] !== out['1_存的词'] && !hasSent(d2.句子, out['1_存的句']),
    '2 英语说明标注为英语': /英语收藏/.test(d2.说明 || ''),
    '2 英语档说明里提示了另有西语 2 条': /另有西语收藏 2 条/.test(d2.说明 || ''),
    '3 切回西语角标当场变回 2': out['3_切回西语徽标'] === '2',
    '3 切回西语抽屉仍是原来那两条': d3.生词[0] === out['1_存的词'] && hasSent(d3.句子, out['1_存的句']),
    '3 切回西语说明里提示了另有英语 2 条': /另有英语收藏 2 条/.test(out['3_切回西语说明'] || ''),
    '3 西语词主键带 es: 前缀': db.词.some((w) => w.id === esWordId && w.lang === 'es' && w.word === out['1_存的词']),
    '3 英语词主键是裸词、lang=en': db.词.some((w) => w.id === enWord && w.word === enWord && w.lang === 'en'),
    '3 库里两种语言的记录都在（共 4 条）': db.词.length === 2 && db.句.length === 2,
    '3 西语句子记录带中间英文行': (d3.句子有英文行 || 0) >= 1,
    '无 JS 异常': errs.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n判定：');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  console.log(failed.length ? `\n✗ 收藏分区有问题：${failed.join(' / ')}` : '\n✓ 收藏分区全部通过');
  ok = failed.length === 0;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
