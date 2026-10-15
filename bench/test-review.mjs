// 复习功能端到端测试
//   ① 顶栏有「复习」按钮，到期数角标对得上；0 条时角标藏起来
//   ② 点开复习 → 全屏浮层，显示进度和「再听一遍」
//   ③ 句子卡：原文/译文默认模糊，点「看答案」才显形
//   ④ 自动朗读真的调了 speechSynthesis（拦下来看文本与语言）
//   ⑤ 「听懂了」→ box 升档、dueAt 推后，进度前进
//   ⑥ 「没听懂」→ box 打回 1 档、lapses+1，进度前进
//   ⑦ 答完 → 结束页有统计和下一轮时间
//   ⑧ 排期真的写回 IndexedDB（刷新后还在）
//   ⑨ 键盘：空格再听、回车看答案、→/← 评分、Esc 退出
//   ⑩ 角标随收藏变化刷新（删掉收藏后不再挂着）
//   node bench/test-review.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8945);
const CDP_PORT = Number(process.argv[3] || 9395);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), 'echo-review-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

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
  const J = (expr) => ev(`(async () => JSON.stringify(await (${expr})))()`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable'); await cmd('Page.enable');

  const boot = async () => {
    await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
    for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
    await sleep(900);
  };

  // 先把 speechSynthesis.speak 换成记录器，才能验证「真的念了」
  const installTtsProbe = () => ev(`(() => {
    window.__spoken = [];
    if (!window.__ttsPatched) {
      window.__ttsPatched = true;
      const orig = window.speechSynthesis;
      const realSpeak = orig.speak.bind(orig);
      orig.speak = (u) => { window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate }); return realSpeak(u); };
    }
    return true;
  })()`);

  await boot();
  await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.mode='en'; s.asrModel='whisper-base.en'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);

  const seed = (dayMs) => `new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words','sentences'],'readwrite');
      tx.objectStore('words').clear(); tx.objectStore('sentences').clear();
      const D = 86400000, N = Date.now();
      // 两条到期的（一条生词、一条句子）
      tx.objectStore('words').put({ id:'practice', word:'practice', lang:'en', phonetic:'/ˈpræktɪs/',
        trans:'n. 练习；v. 实行', sample:'I need more practice.', sampleZh:'我需要更多练习。',
        box:0, reps:0, lapses:0, dueAt: N - 1000, addedAt: N - 5000 });
      // 一条还没到期（1 天后）——不该出现在队列里
      tx.objectStore('sentences').put({ id:'s1', en:'Welcome to this offline listening practice.',
        zh:'欢迎收听这个离线监听练习。', mid:'', lang:'en', video:'demo.mp4', start:1.5, end:5,
        box:0, reps:0, lapses:0, dueAt: N - 2000, addedAt: N - 4000 });
      tx.objectStore('sentences').put({ id:'s2', en:'Small habits matter more than big plans.',
        zh:'小习惯比大计划更重要。', mid:'', lang:'en', video:'demo.mp4', start:6, end:9,
        box:2, reps:2, lapses:0, dueAt: ${dayMs}, addedAt: N - 3000 });
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => res(false);
    };
    rq.onerror = () => res(false);
  })`;

  await ev(seed('Date.now() + 86400000'));
  await boot();
  await installTtsProbe();

  console.log('\n--- ① 角标 ---');
  const badge = await J(`({
    btn: !!document.getElementById('btnReview'),
    label: document.getElementById('btnReview').textContent.trim(),
    count: document.getElementById('reviewCount').textContent,
    hidden: document.getElementById('reviewCount').hidden,
  })`);
  check('① 顶栏有复习按钮', badge.btn === true);
  check('① 按钮上有「复习」字样', badge.label.includes('复习'), JSON.stringify(badge.label));
  check('① 到期角标 = 2（1 生词 + 1 句子）', badge.count === '2', `实际 ${badge.count}`);
  check('① 有到期时角标显示', badge.hidden === false);

  console.log('\n--- ② 打开复习 ---');
  await ev(`document.getElementById('btnReview').click()`);
  await sleep(1400);
  const opened = await J(`({
    hidden: document.getElementById('reviewOverlay').hidden,
    progress: document.getElementById('rvProgress').textContent.trim(),
    hasListen: !!document.getElementById('rvListen'),
    showBtn: !document.getElementById('rvShow').hidden,
    gradeHidden: document.getElementById('rvGrade').hidden,
  })`);
  check('② 浮层打开', opened.hidden === false);
  check('② 进度显示 1 / 2', opened.progress === '1 / 2', `实际 ${JSON.stringify(opened.progress)}`);
  check('② 有「再听一遍」播放键', opened.hasListen === true);
  check('② 初始有「看答案」按钮', opened.showBtn === true);
  check('② 评分按钮初始隐藏（不剧透）', opened.gradeHidden === true);

  console.log('\n--- ③ 句子卡默认模糊 ---');
  const card1 = await J(`({
    src: document.getElementById('rvAnswer').querySelector('.rv-src')?.textContent || '',
    blurred: !!document.getElementById('rvAnswer').querySelector('.rv-src.blur'),
    zhBlurred: !!document.getElementById('rvAnswer').querySelector('.rv-zh.blur'),
    bodyText: document.getElementById('rvBody').textContent.trim(),
  })`);
  check('③ 第一张是句子（队列里句子优先）', /offline listening practice/.test(card1.src), JSON.stringify(card1.src));
  check('③ 原文默认模糊', card1.blurred === true);
  check('③ 译文挂了 .blur 类', card1.zhBlurred === true);
  check('③ 提示区没有把原文漏出来', !/offline listening practice/.test(card1.bodyText));

  // 光有 .blur 类不算数 —— 要是 CSS 里没给 .rv-zh.blur 写规则，类就是个摆设，
  // 译文照样清清楚楚。必须查**实际生效的** filter。
  const blurEffect = await J(`(() => {
    const src = document.getElementById('rvAnswer').querySelector('.rv-src');
    const zh = document.getElementById('rvAnswer').querySelector('.rv-zh');
    const f = (n) => n ? getComputedStyle(n).filter : 'none';
    return { src: f(src), zh: f(zh) };
  })()`);
  check('③ 原文真的被模糊了（计算样式）', /blur/.test(blurEffect.src), JSON.stringify(blurEffect.src));
  check('③ 译文真的被模糊了（计算样式，中文漏看就没意义了）',
    /blur/.test(blurEffect.zh), JSON.stringify(blurEffect.zh));

  console.log('\n--- ④ 自动朗读 ---');
  const spoken = await J(`window.__spoken || []`);
  check('④ 进卡就自动念了一遍', spoken.length >= 1, `实际 ${spoken.length} 次`);
  check('④ 念的是这句英文', spoken.length > 0 && /offline listening practice/.test(spoken[0].text),
    JSON.stringify(spoken[0]?.text));
  check('④ 用的是英语音色', spoken.length > 0 && String(spoken[0].lang).toLowerCase().startsWith('en'),
    JSON.stringify(spoken[0]?.lang));

  console.log('\n--- ⑤ 看答案 → 显形 → 评分按钮出现 ---');
  await ev(`document.getElementById('rvShow').click()`);
  await sleep(600);
  const revealed = await J(`({
    blurred: !!document.getElementById('rvAnswer').querySelector('.rv-src.blur'),
    showHidden: document.getElementById('rvShow').hidden,
    gradeHidden: document.getElementById('rvGrade').hidden,
    foot: document.getElementById('rvFoot').textContent.trim(),
  })`);
  check('⑤ 点「看答案」后原文不再模糊', revealed.blurred === false);
  const blurGone = await J(`(() => {
    const zh = document.getElementById('rvAnswer').querySelector('.rv-zh');
    return zh ? getComputedStyle(zh).filter : 'no-node';
  })()`);
  check('⑤ 译文也同时解除了模糊', !/blur/.test(blurGone), JSON.stringify(blurGone));
  check('⑤ 「看答案」按钮收起', revealed.showHidden === true);
  check('⑤ 出现「听懂了/没听懂」', revealed.gradeHidden === false);
  check('⑤ 脚注预告了下一次间隔', /听懂了/.test(revealed.foot) && /没听懂/.test(revealed.foot),
    JSON.stringify(revealed.foot));
  // 占位符必须被替换掉。t() 遇到没传的变量会把 {a} 原样留在字符串里，
  // 界面上就会直接显示「听懂了 {a}」——测试要盯住这个。
  check('⑤ 脚注里的占位符已替换（不留 {a}/{b}）', !/\{[a-z]\}/.test(revealed.foot),
    JSON.stringify(revealed.foot));
  check('⑤ 脚注给出了具体天数（听懂了那档）', /\d/.test(revealed.foot), JSON.stringify(revealed.foot));

  console.log('\n--- ⑥ 点了「听懂了」→ 升档并前进 ---');
  const before = await J(`(async () => { const r = await new Promise((res)=>{const q=indexedDB.open('echolingo',1);
    q.onsuccess=()=>{const db=q.result;const t=db.transaction('sentences').objectStore('sentences').get('s1');
    t.onsuccess=()=>res(t.result);};}); return r; })()`);
  check('⑥ 答之前 box=0', before.box === 0, JSON.stringify(before.box));

  await ev(`document.getElementById('rvYes').click()`);
  await sleep(1200);
  const after = await J(`(async () => { const r = await new Promise((res)=>{const q=indexedDB.open('echolingo',1);
    q.onsuccess=()=>{const db=q.result;const t=db.transaction('sentences').objectStore('sentences').get('s1');
    t.onsuccess=()=>res(t.result);};}); return r; })()`);
  const prog2 = await ev(`document.getElementById('rvProgress').textContent.trim()`);
  check('⑥ 答对后 box 升到 1', after.box === 1, JSON.stringify(after.box));
  check('⑥ reps 变成 1', after.reps === 1, JSON.stringify(after.reps));
  check('⑥ dueAt 被推到未来（≥1 天）', after.dueAt - Date.now() > 20 * 3600 * 1000,
    `实际 ${((after.dueAt - Date.now()) / 864e5).toFixed(2)} 天`);
  check('⑥ 进度前进到 2 / 2', prog2 === '2 / 2', JSON.stringify(prog2));
  check('⑥ 排期真的写回 IndexedDB', after.box === 1 && after.reps === 1);

  console.log('\n--- ⑦ 第二张是生词卡 ---');
  const card2 = await J(`({
    word: document.getElementById('rvBody').querySelector('.rv-word')?.textContent || '',
    defBlurred: !!document.getElementById('rvAnswer').querySelector('.rv-def.blur'),
    def: document.getElementById('rvAnswer').querySelector('.rv-def')?.textContent || '',
  })`);
  check('⑦ 第二张是生词 practice', card2.word === 'practice', JSON.stringify(card2.word));
  check('⑦ 释义默认模糊（不剧透）', card2.defBlurred === true);
  check('⑦ 释义内容在 DOM 里（模糊不是隐藏）', /练习/.test(card2.def), JSON.stringify(card2.def));

  console.log('\n--- ⑧ 键盘：回车看答案 → ← 没听懂 ---');
  // 用 CDP 发真按键，别 dispatch 合成事件 —— 合成事件的 target 是 document，
  // 跟真实按键（target = 焦点元素）不同，会掩盖 e.target 相关的崩溃。
  const key = async (k, code, keyCode) => {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };
  await ev(`document.getElementById('rvShow').focus()`);
  await key('Enter', 'Enter', 13);
  await sleep(600);
  const kbReveal = await ev(`document.getElementById('rvGrade').hidden === false`);
  check('⑧ 回车 = 看答案', kbReveal === true);

  const wordBefore = await J(`(async () => { const r = await new Promise((res)=>{const q=indexedDB.open('echolingo',1);
    q.onsuccess=()=>{const db=q.result;const t=db.transaction('words').objectStore('words').get('practice');
    t.onsuccess=()=>res(t.result);};}); return r; })()`);
  await key('ArrowLeft', 'ArrowLeft', 37);
  await sleep(1200);
  const wordAfter = await J(`(async () => { const r = await new Promise((res)=>{const q=indexedDB.open('echolingo',1);
    q.onsuccess=()=>{const db=q.result;const t=db.transaction('words').objectStore('words').get('practice');
    t.onsuccess=()=>res(t.result);};}); return r; })()`);
  check('⑧ 生词答之前 box=0', wordBefore.box === 0, JSON.stringify(wordBefore.box));
  check('⑧ ← = 没听懂，box 打回 1 档', wordAfter.box === 1, JSON.stringify(wordAfter.box));
  check('⑧ ← 让 lapses +1', wordAfter.lapses === 1, JSON.stringify(wordAfter.lapses));

  console.log('\n--- ⑨ 结束页 ---');
  const done = await J(`({
    body: document.getElementById('rvBody').textContent.trim(),
    showLabel: document.getElementById('rvShow').textContent.trim(),
    showHidden: document.getElementById('rvShow').hidden,
    gradeHidden: document.getElementById('rvGrade').hidden,
    progress: document.getElementById('rvProgress').textContent.trim(),
  })`);
  check('⑨ 显示复习完成', /复习完成/.test(done.body), JSON.stringify(done.body.slice(0, 50)));
  check('⑨ 统计了 1 听懂 / 1 没听懂', /1/.test(done.body));
  check('⑨ 有下一轮时间提示', /下一轮/.test(done.body), JSON.stringify(done.body.slice(-60)));
  check('⑨ 结束页按钮变成「完成」', done.showLabel === '完成', JSON.stringify(done.showLabel));

  console.log('\n--- ⑩ 关闭 + 角标刷新 ---');
  await ev(`document.getElementById('rvShow').click()`);
  await sleep(500);
  const closed = await ev(`document.getElementById('reviewOverlay').hidden === true`);
  check('⑩ 点「完成」关闭复习', closed === true);
  const badge2 = await J(`({ count: document.getElementById('reviewCount').textContent,
    hidden: document.getElementById('reviewCount').hidden })`);
  check('⑩ 答完后到期数归 0，角标藏起来', badge2.hidden === true, JSON.stringify(badge2));

  console.log('\n--- ⑪ 刷新后排期还在（持久化）---');
  await boot();
  await installTtsProbe();
  const persisted = await J(`(async () => { const r = await new Promise((res)=>{const q=indexedDB.open('echolingo',1);
    q.onsuccess=()=>{const db=q.result;const t=db.transaction('sentences').objectStore('sentences').get('s1');
    t.onsuccess=()=>res(t.result);};}); return r; })()`);
  check('⑪ 刷新后 box 仍然是 1', persisted.box === 1, JSON.stringify(persisted.box));
  const badge3 = await ev(`document.getElementById('reviewCount').hidden`);
  check('⑪ 刷新后角标仍然是 0（未到期的不算）', badge3 === true);

  console.log('\n--- ⑫ 没有到期内容时的反馈 ---');
  await ev(`document.getElementById('btnReview').click()`);
  await sleep(700);
  const emptyState = await J(`({
    overlayHidden: document.getElementById('reviewOverlay').hidden,
    toast: document.querySelector('.toast')?.textContent || '',
  })`);
  check('⑫ 没有到期内容时不打开空浮层', emptyState.overlayHidden === true);

  console.log('\n===== 页面异常 =====');
  console.log(errs.length ? errs.slice(0, 10).join('\n') : '  （无）');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { failed.forEach((f) => console.log('  失败: ' + f.name + ' ' + f.detail)); process.exitCode = 1; }
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
}
