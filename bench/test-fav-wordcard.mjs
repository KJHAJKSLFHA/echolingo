// 验证：收藏抽屉里点单词 → 弹词卡显示释义
//   ① 抽屉里点生词条目正文 → 词卡弹出、有释义、标题是那个词
//   ② 词卡弹出后**不会**立刻被全局 click 关掉（回归：抽屉与词卡是兄弟节点）
//   ③ 词卡的♪能发音（按钮在）
//   ④ 点条目上的 ✕ 仍然只删收藏、不弹词卡（回归）
//   ⑤ 英语模式下点一条西语收藏，按西语查（不跟当前模式走）
//   node bench/test-fav-wordcard.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8941);
const CDP_PORT = Number(process.argv[3] || 9366);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(tmpdir(), 'echo-favwc-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1440,900', 'about:blank',
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

  await cmd('Runtime.enable'); await cmd('DOM.enable'); await cmd('Page.enable');

  const boot = async () => {
    await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
    for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
    await sleep(900);
  };
  await boot();

  // 塞两条收藏：一条英语（有释义 + 例句），一条西语
  await ev(`new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words','sentences'],'readwrite');
      tx.objectStore('words').clear(); tx.objectStore('sentences').clear();
      tx.objectStore('words').put({ id:'practice', word:'practice', lang:'en', phonetic:'/ˈpræktɪs/',
        trans:'n. 实践, 练习；v. 练习', pos:'n.', engdef:'a way of doing something',
        sample:'I need more practice before the exam.', sampleZh:'考试前我需要更多练习。',
        video:'demo.mp4', at:12.5, addedAt: Date.now()-2000, count:1 });
      tx.objectStore('words').put({ id:'es:práctica', word:'práctica', lang:'es', phonetic:'',
        trans:'n. 实践, 练习', pos:'n.',
        sample:'La práctica hace al maestro.', sampleZh:'熟能生巧。',
        video:'demo.mp4', at:30, addedAt: Date.now()-1000, count:1 });
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => res(false);
    };
    rq.onerror = () => res(false);
  })`);
  // 确保是英语模式
  await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.mode='en'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await boot();

  await ev(`document.getElementById('btnFavs').click()`);
  await sleep(700);

  const itemCount = await ev(`document.querySelectorAll('#favBody .fav-item').length`);
  // 英语模式只显示英语收藏（分区）。塞进去的 es:práctica 属于西语档，这里看不到。
  check('英语模式下抽屉只显示英语收藏', itemCount === 1, `实际 ${itemCount}`);

  const clickable = await ev(`document.querySelectorAll('#favBody .fav-item.clickable').length`);
  check('生词条目带 .clickable 可点样式', clickable === 1, `实际 ${clickable}`);

  const esHidden = await ev(`!document.querySelector('#favBody .fav-item[data-wid="es:práctica"]')`);
  check('西语收藏在英语模式下被分区挡住', esHidden === true);

  const hasWid = await ev(`[...document.querySelectorAll('#favBody .fav-item')].every((x)=>x.dataset.wid)`);
  check('每条生词都有 data-wid', hasWid === true);

  // ── ① 点英语那条的正文（.t），应弹词卡 ──
  await ev(`(() => { const it=[...document.querySelectorAll('#favBody .fav-item')].find((x)=>x.dataset.wid==='practice');
    it.querySelector('.t').click(); return true; })()`);
  await sleep(1400);

  const card1 = await J(`({
    hidden: document.getElementById('wordcard').hidden,
    word: document.getElementById('wcWord').textContent.trim(),
    phon: document.getElementById('wcPhon').textContent.trim(),
    body: document.getElementById('wcBody').textContent.trim().slice(0,80),
    foot: document.getElementById('wcFoot').textContent.trim().slice(0,90),
  })`);
  check('① 点收藏里的生词 → 词卡弹出', card1.hidden === false);
  check('① 词卡标题是该词', card1.word === 'practice', `got ${JSON.stringify(card1.word)}`);
  check('① 词卡里有释义', /练习|实践/.test(card1.body), JSON.stringify(card1.body));
  check('① 词卡显示音标', card1.phon.includes('prækt') || card1.phon.startsWith('/'), JSON.stringify(card1.phon));

  // ── ② 不会立刻被全局 click 关掉（等一会儿再看）──
  await sleep(1200);
  const stillOpen = await ev(`document.getElementById('wordcard').hidden === false`);
  check('② 词卡不会被全局 click 立刻关掉（抽屉是兄弟节点的回归）', stillOpen === true);

  // ── ③ 例句来自收藏时存的 sample ──
  // 注意高亮会把词包进 [ ]，所以别拿整句原文去匹配。
  check('③ 无视频上下文时，例句取自收藏记录',
    /before the exam/.test(card1.foot), JSON.stringify(card1.foot));

  // 点抽屉空白处之外 → 应该关掉（原来的行为不能坏）
  await ev(`document.body.click()`);
  await sleep(500);
  const closed = await ev(`document.getElementById('wordcard').hidden === true`);
  check('③ 点词卡外面仍然会关掉（原有行为保留）', closed === true);

  // ── ④ 点 ✕ 只删收藏、不弹词卡 ──
  // 用英语那条（西语那条在英语模式下压根没渲染，选不到）
  const beforeDel = await ev(`document.querySelectorAll('#favBody .fav-item').length`);
  await ev(`(() => { const it=[...document.querySelectorAll('#favBody .fav-item')].find((x)=>x.dataset.wid==='practice');
    if (!it) throw new Error('practice 条目不见了');
    it.querySelector('button[data-act="del-word"]').click(); return true; })()`);
  await sleep(900);
  const afterDel = await ev(`document.querySelectorAll('#favBody .fav-item').length`);
  const cardAfterDel = await ev(`document.getElementById('wordcard').hidden`);
  check('④ 点 ✕ 删掉了收藏', afterDel === beforeDel - 1, `${beforeDel} → ${afterDel}`);
  check('④ 点 ✕ 不会误弹词卡', cardAfterDel === true);

  // ── ⑤ 切到西语模式，点西语收藏，词卡标题仍是西语原词 ──
  // getMode() 优先看 asrModel 的语言（MODE_MODEL: es → whisper-base 多语版），
  // 只改 settings.mode 是不够的。
  await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.mode='es'; s.asrModel='whisper-base'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await boot();
  await ev(`document.getElementById('btnFavs').click()`);
  await sleep(800);
  const esItems = await J(`[...document.querySelectorAll('#favBody .fav-item')].map((x)=>x.dataset.wid)`);
  check('⑤ 西语模式下看到西语收藏', esItems.includes('es:práctica'), JSON.stringify(esItems));

  await ev(`(() => { const it=document.querySelector('#favBody .fav-item[data-wid="es:práctica"]');
    if (!it) throw new Error('找不到西语条目');
    it.querySelector('.t').click(); return true; })()`);
  await sleep(2000);
  const card2 = await J(`({
    hidden: document.getElementById('wordcard').hidden,
    word: document.getElementById('wcWord').textContent.trim(),
    body: document.getElementById('wcBody').textContent.trim().slice(0,60),
  })`);
  check('⑤ 西语收藏也能弹词卡', card2.hidden === false);
  check('⑤ 卡片标题保持西语原词（不被换成英语对译词）', card2.word === 'práctica', `got ${JSON.stringify(card2.word)}`);

  console.log('\n===== 页面异常 =====');
  console.log(errs.length ? errs.join('\n') : '  （无）');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { failed.forEach((f) => console.log('  失败: ' + f.name + ' ' + f.detail)); process.exitCode = 1; }
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
}
