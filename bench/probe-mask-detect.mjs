// 诊断脚本（不是验收）：拿一条**真视频**跑现有的「自动定位字幕带」算法，
// 把逐行剖面、三路特征、以及几帧的 ASCII 亮度图都打出来。
//
// 用途：用户反馈「这条西语视频没找到烧录字幕」。不看清它到底看到了什么，
// 就只能猜。这个脚本负责把「猜」变成「读数字」。
//
//   node bench/probe-mask-detect.mjs [httpPort] [cdpPort] [视频路径] [采样帧数]
//
// 输出三块：
//   ① 视频几何 + 检测器 summary（frames / bestVal / mean / prominence / result）
//   ② 逐行剖面（y、相对高度%、edge、change、variance、score）—— 只打下半部
//   ③ 3 帧的 ASCII 亮度图，用来肉眼（这里是"读字符"）确认字幕到底在哪一行
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9350);
const MEDIA = process.argv[4] || '/Users/orion/Movies/西语Vlog｜我终于来到了巴塔哥尼亚.mp4';
const N = Number(process.argv[5] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探针页由脚本自己写出来、跑完删掉：它只是给 <video> 一个同源的落脚点，
// 好让页面能 import 到 app/js/subtitle-mask.js 的真身。
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '_mask-probe.html');
const FIX = join(HERE, 'fixtures', 'mask-profile-vlog.json');   // 逐行剖面存这里，当回归素材
writeFileSync(PROBE, `<!doctype html><meta charset="utf-8"><title>mask probe</title>
<style>body{margin:0;background:#111;color:#888;font:12px monospace}</style>
<input type="file" id="f" accept="video/*">
<video id="v" muted playsinline></video>
`);

const profile = join(tmpdir(), 'echo-mask-probe-profile');
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
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/bench/_mask-probe.html` });
  await sleep(600);

  const doc = await cmd('DOM.getDocument', { depth: 1 });
  const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f' });
  console.log('导入视频:', MEDIA);
  await cmd('DOM.setFileInputFiles', { files: [MEDIA], nodeId: q.nodeId });

  const setup = await ev(`(async () => {
    const M = await import('../app/js/subtitle-mask.js');
    const v = document.getElementById('v');
    const f = document.getElementById('f').files[0];
    if (!f) throw new Error('文件没进去');
    v.src = URL.createObjectURL(f);
    await new Promise((res, rej) => {
      v.addEventListener('loadedmetadata', res, { once: true });
      v.addEventListener('error', () => rej(new Error('video error')), { once: true });
      setTimeout(res, 30000);
    });
    window.__M = M; window.__v = v;
    window.__det = M.createBandDetector();
    window.__cv = document.createElement('canvas');
    window.__seek = (t) => new Promise((res) => {
      const h = () => { v.removeEventListener('seeked', h); res(v.currentTime); };
      v.addEventListener('seeked', h);
      v.currentTime = t;
    });
    window.__grab = () => M.grabGrayFrame(v, window.__det, window.__cv);
    window.__ascii = (cols, rows) => {
      const c = document.createElement('canvas'); c.width = cols; c.height = rows;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(v, 0, 0, cols, rows);
      const d = x.getImageData(0, 0, cols, rows).data;
      const ramp = ' .:-=+*#%@';
      const lines = [];
      for (let ry = 0; ry < rows; ry++) {
        let s = '';
        for (let rx = 0; rx < cols; rx++) {
          const p = (ry * cols + rx) * 4;
          const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
          s += ramp[Math.min(9, (g * 10) >> 8)];
        }
        lines.push(s);
      }
      return lines;
    };
    return { dur: v.duration, w: v.videoWidth, h: v.videoHeight };
  })()`);
  console.log('视频几何:', JSON.stringify(setup));

  const dur = setup.dur;
  const times = [];
  for (let i = 0; i < N; i++) times.push(+(3 + (dur - 6) * (i + 0.5) / N).toFixed(2));

  const shots = [];
  let pushed = 0;
  for (const t of times) {
    await ev(`window.__seek(${t})`);
    const got = await ev(`window.__grab()`);
    if (got) pushed++;
    if (shots.length < 3) shots.push({ t, art: await J(`window.__ascii(96, 40)`) });
  }
  console.log(`采样 ${times.length} 帧，成功喂进检测器 ${pushed} 帧`);

  const prof = await J(`window.__det.profile()`);
  const res = await J(`window.__det.result()`);

  console.log('\n===== ① 检测器结论 =====');
  console.log(JSON.stringify({
    frames: prof?.frames, W: prof?.W, H: prof?.H, yStart: prof?.yStart,
    best: prof?.best, bestRowPct: prof ? +((prof.best / prof.H) * 100).toFixed(1) : null,
    bestVal: prof?.bestVal, bg: prof?.bg, prominence: prof?.prominence,
    result: res,
  }, null, 2));

  // 把逐行剖面存成回归测试的固定素材：真视频 900MB 不适合当测试用例，
  // 但剖面只有几 KB，bench/test-band-detect.mjs 会原样重放它。
  if (prof) {
    mkdirSync(join(HERE, 'fixtures'), { recursive: true });
    writeFileSync(FIX, JSON.stringify({
      note: '真实逐行剖面：西语 Vlog（手持镜头水面，旧算法在这条上找不到字幕），30 帧采样，320×180',
      source: MEDIA, W: prof.W, H: prof.H, frames: prof.frames, best: prof.best,
      edge: prof.edge.map((v) => +v.toFixed(4)),
      change: prof.change.map((v) => +v.toFixed(4)),
      variance: prof.variance.map((v) => +v.toFixed(4)),
    }, null, 1) + '\n');
    console.log(`逐行剖面已存到 ${FIX}`);
  }

  if (prof) {
    console.log('\n===== ② 逐行剖面（只打下半部）=====');
    console.log('  y   高度%    edge    change   variance   score     bar');
    let maxScore = 0;
    for (let y = prof.yStart; y < prof.H; y++) maxScore = Math.max(maxScore, prof.score[y]);
    for (let y = prof.yStart; y < prof.H; y++) {
      const bar = '█'.repeat(Math.round((prof.score[y] / (maxScore || 1)) * 24));
      const mark = y === prof.best ? ' <== best' : '';
      console.log(
        String(y).padStart(3), ((y / prof.H) * 100).toFixed(1).padStart(6) + '%',
        prof.edge[y].toFixed(2).padStart(8), prof.change[y].toFixed(2).padStart(9),
        prof.variance[y].toFixed(0).padStart(10), prof.score[y].toFixed(4).padStart(9),
        ' ' + bar + mark,
      );
    }
  }

  console.log('\n===== ③ 帧的 ASCII 亮度图（看清字幕在哪一行）=====');
  for (const s of shots) {
    console.log(`\n--- t=${s.t}s （40 行，每行 = 画面高度的 ${(100 / 40).toFixed(1)}%；左列数字是行号）---`);
    s.art.forEach((line, i) => console.log(String(i).padStart(2), '|' + line + '|'));
  }

  console.log('\n页面异常:', errs.length ? errs : '[]');
  ok = true;
} catch (e) {
  console.error('探针失败:', e.message);
} finally {
  chrome.kill('SIGKILL');
  try { unlinkSync(PROBE); } catch {}
}
process.exit(ok ? 0 : 1);
