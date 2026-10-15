// 截图：收藏抽屉里点单词弹出词卡（修复后的效果）
//   node bench/shot-fav-wordcard.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8991);
const CDP_PORT = Number(process.argv[3] || 9391);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), 'echo-shot-favwc');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
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
  await cmd('Runtime.enable'); await cmd('Page.enable');

  const boot = async () => {
    await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
    for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
    await sleep(900);
  };
  await boot();

  // 深色主题 + 几条收藏
  await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.mode='en'; s.asrModel='whisper-base.en'; s.theme='dark'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await ev(`new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words','sentences'],'readwrite');
      tx.objectStore('words').clear(); tx.objectStore('sentences').clear();
      tx.objectStore('words').put({ id:'practice', word:'practice', lang:'en', phonetic:'/ˈpræktɪs/',
        trans:'n. 实践, 练习, 实行, 惯例, 习惯, 开业；v. 实践, 实行, 练习, 实习, 业务', pos:'n.',
        engdef:'a customary way of operation or behavior',
        sample:'Welcome to this offline listening practice.', sampleZh:'欢迎收听这个离线监听练习。',
        video:'demo.mp4', at:0, addedAt: Date.now()-3000, count:1 });
      tx.objectStore('words').put({ id:'habits', word:'habits', lang:'en', phonetic:'/ˈhæbɪts/',
        trans:'n. 习惯, 习性；v. 使穿衣', pos:'n.',
        sample:'why small habits matter more than big plans', sampleZh:'为什么小习惯比大计划更重要。',
        video:'demo.mp4', at:5.2, addedAt: Date.now()-2000, count:1 });
      tx.objectStore('words').put({ id:'matter', word:'matter', lang:'en', phonetic:'/ˈmætər/',
        trans:'n. 物质, 事件；v. 有关系', pos:'n.',
        sample:'why small habits matter more than big plans', sampleZh:'为什么小习惯比大计划更重要。',
        video:'demo.mp4', at:5.2, addedAt: Date.now()-1000, count:1 });
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => res(false);
    };
    rq.onerror = () => res(false);
  })`);
  await boot();

  await ev(`document.getElementById('btnFavs').click()`);
  await sleep(700);
  // 点第二条的单词正文，让词卡弹出来（避开第一条，好看清上下关系）
  await ev(`(() => { const it=[...document.querySelectorAll('#favBody .fav-item')].find((x)=>x.dataset.wid==='habits');
    it.querySelector('.t').click(); return true; })()`);
  await sleep(1600);

  const shot1 = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync('bench/shots/fav-wordcard-dark.png', Buffer.from(shot1.data, 'base64'));
  console.log('✓ bench/shots/fav-wordcard-dark.png');

  // 浅色主题再来一张
  await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.theme='light'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await boot();
  await ev(`document.getElementById('btnFavs').click()`);
  await sleep(700);
  await ev(`(() => { const it=[...document.querySelectorAll('#favBody .fav-item')].find((x)=>x.dataset.wid==='practice');
    it.querySelector('.t').click(); return true; })()`);
  await sleep(1600);
  const shot2 = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync('bench/shots/fav-wordcard-light.png', Buffer.from(shot2.data, 'base64'));
  console.log('✓ bench/shots/fav-wordcard-light.png');
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
}
