// 给「在画面上拖动调整遮罩」拍一张真实截图（用户要看效果）。
// 现场录一段小视频导入，进调整态，截图 → shots/mask-adjust.png
//   node bench/shot-mask-adjust.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9356);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'shots/mask-adjust.png';
mkdirSync('shots', { recursive: true });

const profile = join(tmpdir(), 'echo-maskshot-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',   // 否则 AudioContext 是挂起的，录不出数据
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch { /* wait */ }
    await sleep(250);
  }
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cmd = async (method, params) => {
    const i = ++id;
    const m = await new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
    return m.result;
  };
  const ev = (expr) => cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value);

  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 200; i++) { if (await ev(`!!document.getElementById('player')`)) break; await sleep(300); }
  await ev(`localStorage.setItem('echolingo.settings.v1', JSON.stringify({ lang: 'zh', theme: 'dark',
    mask: { enabled: true, style: 'soft', strength: 34, topRatio: 0.79, bottomRatio: 0.945, auto: false } }))`);
  await cmd('Page.reload');
  for (let i = 0; i < 200; i++) { if (await ev(`typeof window.__ECHOLINGO_VER__ !== 'undefined' && !!document.getElementById('btnMaskAdjust')`)) break; await sleep(300); }

  const evx = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  // 现场录一段更像视频的画面（渐变天空 + 底部两行"字幕"）
  console.log('录制结果：' + await evx(`(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const stream = c.captureStream(25);
    try { const ac = new (window.AudioContext || window.webkitAudioContext)();
      const d = ac.createMediaStreamDestination(); const gn = ac.createGain(); gn.gain.value = 0;
      const o = ac.createOscillator(); o.connect(gn); gn.connect(d); o.start();
      d.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr)); } catch (e) {}
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; }); rec.start();
    const s0 = performance.now();
    while (performance.now() - s0 < 2000) {
      const k = (performance.now() - s0) / 2000;
      const sky = g.createLinearGradient(0, 0, 0, 360);
      sky.addColorStop(0, 'hsl(205,' + (58 - k * 18) + '%,' + (24 + k * 9) + '%)');
      sky.addColorStop(1, 'hsl(30,' + (42 + k * 14) + '%,' + (48 + k * 6) + '%)');
      g.fillStyle = sky; g.fillRect(0, 0, 640, 360);
      // 一点"景物"，方便看出画面确实是视频
      g.fillStyle = 'rgba(255,255,255,.10)';
      for (let i = 0; i < 5; i++) g.fillRect(0, 150 + i * 14, 640, 6);
      g.beginPath(); g.arc(500 + k * 40, 90, 34, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,236,180,.55)'; g.fill();
      g.font = '600 21px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillText('Hola, soy Cynthia y hoy vamos al lago.', 322, 300);
      g.fillText('No dejéis de ver el final del vídeo.', 322, 331);
      g.fillStyle = '#fff';
      g.fillText('Hola, soy Cynthia y hoy vamos al lago.', 320, 298);
      g.fillText('No dejéis de ver el final del vídeo.', 320, 329);
      await new Promise((r) => setTimeout(r, 40));
    }
    rec.stop(); await done;
    const file = new File(chunks, 'demo-640x360.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const inp = document.getElementById('fileVideo'); inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + file.size;
  })()`));
  await sleep(400);
  const meta = await ev(`(async () => {
    const p = document.getElementById('player');
    await new Promise((r) => { if (p.videoWidth) return r();
      p.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 20000); });
    return p.videoWidth + 'x' + p.videoHeight + ' disp=' + getComputedStyle(p).display;
  })()`);
  console.log('视频：' + meta);
  // 进调整态（走真实按钮）
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(300);
  await ev(`document.getElementById('btnMaskAdjust').click()`);
  await sleep(700);
  await ev(`document.getElementById('player').currentTime = 1.0`);
  await sleep(800);
  console.log('遮罩盒：' + await ev(`(() => { const n = document.querySelector('.submask'); const b = n.getBoundingClientRect();
    return JSON.stringify({ hidden: n.hidden, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }); })()`));

  const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  const info = await ev(`(() => {
    const r = (s) => { const n = document.querySelector(s); if (!n) return null;
      const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return JSON.stringify({ box: r('.submask-edit-box'), gripTop: r('.submask-edit-grip.top'),
      gripBot: r('.submask-edit-grip.bottom'), done: r('.submask-edit-done'),
      hint: (document.querySelector('.submask-edit-hint') || {}).textContent,
      saved: JSON.parse(localStorage.getItem('echolingo.settings.v1')).mask });
  })()`);
  console.log('已写出 ' + OUT);
  console.log(info);
} finally {
  chrome.kill('SIGKILL');
}
