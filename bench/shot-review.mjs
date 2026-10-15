// 截图：复习功能（正面 / 看答案后 / 结束页，深色+浅色）
//   node bench/shot-review.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8996);
const CDP_PORT = Number(process.argv[3] || 9396);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), 'echo-shot-review');
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
  const shot = async (name) => {
    const s = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`bench/shots/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('✓ bench/shots/' + name + '.png');
  };

  const seed = `new Promise((res) => {
    const rq = indexedDB.open('echolingo', 1);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(['words','sentences'],'readwrite');
      tx.objectStore('words').clear(); tx.objectStore('sentences').clear();
      const N = Date.now();
      tx.objectStore('sentences').put({ id:'s1',
        en:'Today we are going to talk about why small habits matter more than big plans.',
        zh:'今天我们要讲的是，为什么小习惯比大计划更重要。',
        mid:'', lang:'en', video:'habits.mp4', start:12.4, end:18.2,
        box:0, reps:0, lapses:0, dueAt: N - 3000, addedAt: N - 9000 });
      tx.objectStore('words').put({ id:'practice', word:'practice', lang:'en', phonetic:'/ˈpræktɪs/',
        trans:'n. 练习, 实践；v. 实行, 实习', engdef:'a customary way of operation or behavior',
        sample:'Welcome to this offline listening practice.', sampleZh:'欢迎收听这个离线监听练习。',
        box:2, reps:2, lapses:0, dueAt: N - 2000, addedAt: N - 8000 });
      tx.objectStore('words').put({ id:'habits', word:'habits', lang:'en', phonetic:'/ˈhæbɪts/',
        trans:'n. 习惯, 习性', sample:'why small habits matter', sampleZh:'为什么小习惯重要',
        box:1, reps:1, lapses:0, dueAt: N - 1000, addedAt: N - 7000 });
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => res(false);
    };
    rq.onerror = () => res(false);
  })`;

  for (const theme of ['dark', 'light']) {
    await boot();
    await ev(`(() => { const k='echolingo.settings.v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
      s.mode='en'; s.asrModel='whisper-base.en'; s.theme='${theme}'; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
    await ev(seed);
    await boot();

    // 顶栏角标
    await shot(`review-badge-${theme}`);

    // 打开复习 → 句子正面（模糊）
    await ev(`document.getElementById('btnReview').click()`);
    await sleep(1800);
    await shot(`review-front-${theme}`);

    // 看答案
    await ev(`document.getElementById('rvShow').click()`);
    await sleep(900);
    await shot(`review-revealed-${theme}`);

    // 答完三张 → 结束页
    for (let i = 0; i < 3; i++) {
      await ev(`document.getElementById('rvYes')?.click(); document.getElementById('rvNo')?.click();`);
      await sleep(700);
    }
    await shot(`review-done-${theme}`);
    await ev(`document.getElementById('reviewOverlay').hidden || document.getElementById('rvShow').click()`);
    await sleep(400);
  }
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
}
