// 阶段 5 验证：西语模式下的词卡与朗读
//   ① 西语分词不再被切碎（重音词是完整的 token）
//   ② 点西语词 → 卡片标题是西语原词、没有英语音标、释义是中文、脚注写明「西语 → 英文：xxx」
//   ③ 点朗读真的走西语音色（拦 speechSynthesis.speak 看 u.lang / u.voice）
//   ④ 设置抽屉里的音色池跟着模式换；在西语模式选的音色存进 voiceEs，切回英语不丢
//   ⑤ 英语模式回到原样：有音标、没有西语脚注、朗读是英语音色
//   node bench/test-es-wordcard.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9342);
const ES_AUDIO = new URL('./es-test.wav', import.meta.url).pathname;
const EN_AUDIO = new URL('./en-test.wav', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 固定 profile：模型上百 MB，每次换新目录都等于重下一遍
const profile = join(tmpdir(), 'echo-wordcard-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const cjkRatio = (s) => {
  const dense = String(s || '').replace(/\s+/g, '');
  if (!dense) return 0;
  return (dense.match(/[\u4e00-\u9fff]/g) || []).length / dense.length;
};

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
  const J = (expr) => ev(`JSON.stringify(${expr})`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }

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
  // 等字幕全部翻译完（wantMid=false 时 mid 必须是 0）
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
  // 单击字幕里第一个（可带重音的）词，返回点了哪个词
  const clickWord = () => ev(`(() => {
    const ws = [...document.querySelectorAll('#subs .cue-en .w')];
    if (!ws.length) return '';
    const w = ws.find((x) => /[áéíóúüñ]/i.test(x.textContent)) || ws[0];
    w.click();
    return w.textContent.trim();
  })()`);
  // 等词卡把释义填出来（西语要先跑一次 es→en 推理，慢）
  const waitCard = async (maxMs = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = await J(`({
        显示: !document.getElementById('wordcard').hidden,
        词: document.getElementById('wcWord')?.textContent.trim() || '',
        音标: document.getElementById('wcPhon')?.textContent.trim() || '',
        释义: document.getElementById('wcBody')?.textContent.trim() || '',
        脚注: document.getElementById('wcFoot')?.textContent.trim() || '',
        脚注HTML: document.getElementById('wcFoot')?.innerHTML || ''
      })`);
      if (s.显示 && s.释义 && !/查询中|Looking|Buscando/.test(s.音标)) return s;
      await sleep(500);
    }
    return await J(`({
      显示: !document.getElementById('wordcard').hidden,
      词: document.getElementById('wcWord')?.textContent.trim() || '',
      音标: document.getElementById('wcPhon')?.textContent.trim() || '',
      释义: document.getElementById('wcBody')?.textContent.trim() || '',
      脚注: document.getElementById('wcFoot')?.textContent.trim() || ''
    })`);
  };
  // 拦下 speechSynthesis.speak，看真正交给系统的 lang / voice 是什么
  const patchSpeak = () => ev(`(() => {
    window.__spoke = null; window.__patchErr = '';
    try {
      speechSynthesis.speak = (u) => {
        window.__spoke = { text: (u.text || '').slice(0, 40), lang: u.lang || '', voice: u.voice ? u.voice.name : '' };
      };
    } catch (e) { window.__patchErr = String(e); }
    return true;
  })()`);
  const clickSpeak = async () => {
    await ev(`document.getElementById('wcSpeak').click()`);
    await sleep(900);
    return J(`({ spoke: window.__spoke, patchErr: window.__patchErr })`);
  };
  const voicePool = async () => {
    await ev(`document.querySelector('#btnSettings').click()`);
    await sleep(400);
    return J(`({
      列表: [...document.querySelectorAll('#setVoice option')].filter((o) => o.value).map((o) => ({ 名: o.value, 文: o.textContent })),
      选中: document.getElementById('setVoice').value,
      抽屉开着: !document.getElementById('setDrawer').hidden
    })`);
  };
  const pickFirstVoice = async () => {
    await ev(`(() => {
      const sel = document.getElementById('setVoice');
      const o = [...sel.options].find((x) => x.value);
      if (!o) return '';
      sel.value = o.value;
      sel.dispatchEvent(new Event('change'));
      return o.value;
    })()`);
    await sleep(300);
    return J(`Object.assign(JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}'), {})`);
  };
  const saveState = () => J(`JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}')`);

  /* ── 1) 西语模式 + 西语音频 → 三行齐 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="es"]').click()`);
  await sleep(600);
  out['1_模型就绪'] = await ready('whisper-base', 300000);
  await importFile(ES_AUDIO);
  out['1_三行齐'] = await waitCues(true);
  out['1_词元'] = await J(`[...document.querySelectorAll('#subs .cue')]
    .flatMap((c) => [...c.querySelectorAll('.cue-en .w')].map((w) => w.textContent.trim()))`);
  out['1_句子'] = await J(`[...document.querySelectorAll('#subs .cue')].map((c) => ({
    原文: c.querySelector('.cue-en')?.textContent.trim() || '',
    英文: c.querySelector('.cue-mid')?.textContent.trim() || '',
    中文: c.querySelector('.cue-zh')?.textContent.trim() || ''
  }))`);

  /* ── 2) 点一个带重音的西语词 ── */
  out['2_点的词'] = await clickWord();
  out['2_词卡'] = await waitCard();

  /* ── 3) 朗读：必须是西语音色 ── */
  await patchSpeak();
  out['3_朗读'] = await clickSpeak();

  /* ── 4) 设置抽屉的音色池 + 分槽存档 ── */
  out['4_音色池'] = await voicePool();
  out['4_选中的音色'] = await pickFirstVoice();

  /* ── 5) 切回英语（取消重识别）→ 导入英语音频 → 词卡回到原样 ── */
  await ev(`document.querySelector('#modeSeg button[data-mode="en"]').click()`);
  await sleep(600);
  out['5_弹窗'] = await ev(`!document.getElementById('askModal').hidden`);
  await ev(`document.getElementById('askCancel').click()`);
  out['5_英语模型就绪'] = await ready('whisper-base.en', 300000);
  out['5_切回英语后的存档'] = await saveState();
  out['5_英语音色池'] = await voicePool();
  await importFile(EN_AUDIO);
  out['5_英语字幕就绪'] = await waitCues(false);
  out['5_英语分词'] = await J(`[...document.querySelectorAll('#subs .cue')]
    .flatMap((c) => [...c.querySelectorAll('.cue-en .w')].map((w) => w.textContent.trim()))`);
  out['5_点的词'] = await clickWord();
  out['5_词卡'] = await waitCard();
  await patchSpeak();
  out['5_朗读'] = await clickSpeak();
  out['5_最终存档'] = await saveState();

  out['异常'] = errs.slice(0, 3);
  console.log(JSON.stringify(out, null, 1));

  /* ── 判定 ── */
  const t1 = out['1_词元'] || [];
  const accentedWhole = t1.some((w) => /[áéíóúüñ]/i.test(w)) && t1.every((w) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+$/.test(w));
  const sents = out['1_句子'] || [];
  const threeLines = sents.length > 0 && sents.every((s) => s.原文 && s.英文 && s.中文);
  const midEnglish = sents.every((s) => cjkRatio(s.英文) < 0.1);
  const zhChinese = sents.every((s) => cjkRatio(s.中文) > 0.3);

  const c2 = out['2_词卡'] || {};
  const esCardOk = c2.词 === out['2_点的词'] && !c2.音标 && cjkRatio(c2.释义) > 0.15 && /西语\s*→\s*英文/.test(c2.脚注);
  const esSpeak = (out['3_朗读'] || {}).spoke || {};
  const esSpeakOk = /^es\b|^es-/i.test(esSpeak.lang || '');

  const pool4 = out['4_音色池'] || { 列表: [] };
  // 选项文案是「名字 · es-ES · 本地」，语言就是中间那一段。
  // 别用 /^.*·/ 去剔前缀 —— 贪婪匹配会一路吃到最后一个 ·，剩下的只有「本地」。
  const langOf = (txt) => (String(txt).split(' · ')[1] || '');
  const pool4Ok = pool4.列表.length >= 2 && pool4.列表.every((o) => /^es([-_]|$)/i.test(langOf(o.文)));
  const picked = out['4_选中的音色'] || {};
  const esSaved = (out['5_切回英语后的存档'] || {}).voiceEs || '';
  const slotOk = !!esSaved && !!picked && Object.values(picked).includes(esSaved);

  const pool5 = out['5_英语音色池'] || { 列表: [] };
  const pool5Ok = pool5.列表.length >= 2 && pool5.列表.every((o) => /^en([-_]|$)/i.test(langOf(o.文)));
  const enKeepsEs = ((out['5_最终存档'] || {}).voiceEs || '') === esSaved;
  const enUnset = !(out['5_切回英语后的存档'] || {}).voiceEn;

  const c5 = out['5_词卡'] || {};
  const enCardOk = !!c5.词 && !!c5.音标 && cjkRatio(c5.释义) > 0.15 && !/西语\s*→\s*英文/.test(c5.脚注);
  const enSpeak = (out['5_朗读'] || {}).spoke || {};
  const enSpeakOk = /^en\b|^en-/i.test(enSpeak.lang || '');
  const enWords = out['5_英语分词'] || [];
  const enWordsOk = enWords.length > 0 && enWords.every((w) => /^[A-Za-z'’-]+$/.test(w));

  const checks = {
    '1 西语模型就绪': out['1_模型就绪'] === true,
    '1 三行齐': out['1_三行齐'] === true,
    '1 原文是西语/英文是英语/中文是中文': threeLines && midEnglish && zhChinese,
    '1 重音词完整未被切碎': accentedWhole,
    '2 词卡：西语原词+无英语音标+中文释义+西语→英文脚注': esCardOk,
    '3 朗读走西语音色': esSpeakOk,
    '4 音色池全是西语': pool4Ok,
    '4 西语选的音色存进 voiceEs': slotOk,
    '5 切英语弹窗+取消': out['5_弹窗'] === true,
    '5 英语模型就绪': out['5_英语模型就绪'] === true,
    '5 音色池全是英语': pool5Ok,
    '5 英语槽仍为空（没被写脏）': enUnset,
    '5 西语槽没被覆盖': enKeepsEs,
    '5 英语字幕+分词正常': out['5_英语字幕就绪'] === true && enWordsOk,
    '5 词卡回到英语样子': enCardOk,
    '5 朗读走英语音色': enSpeakOk,
    '无 JS 异常': errs.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n判定：');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  console.log(failed.length ? `\n✗ 西语词卡与朗读有问题：${failed.join(' / ')}` : '\n✓ 西语词卡与朗读全部通过');
  ok = failed.length === 0;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
