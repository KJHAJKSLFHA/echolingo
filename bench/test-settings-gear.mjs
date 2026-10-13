// 阶段 7 验证：顶栏最右边那个设置入口换成了真齿轮
//
// 视觉没法肉眼验收（本会话读不了图片），所以做的是**像素测量**：
// 把图标栅格化成 480×480 的二值墨迹，只看外圈那一环（0.60R~0.80R），量三件事 ——
//   ① 环带角度覆盖率：太阳是 8 根细辐条，只有少量角度有笔画；
//      齿轮是一圈带齿的本体，大部分角度都有笔画。
//   ② 最长环向连通段：太阳每一段只有十几度；齿轮是一整圈（>300°）。
//   ③ 与主题栏太阳图标的 IoU 重合度：改动前的设置图标和太阳几乎重合，
//      改动后必须明显掉下来 —— 用户原话就是「跟太阳分不出哪个是设置」。
// ⚠️ 主题图标会随浅色/深色在太阳和月亮之间切换。必须先切浅色再量，
//    否则量到的是月亮（月牙又长又连续，会被误判成「像齿轮」）。
//    node bench/test-settings-gear.mjs [httpPort] [cdpPort]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9346);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 改动前的旧设置图标：小圆 + 八条射线（和太阳几乎一模一样）
const OLD_SETTINGS = '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>';
// 浅色主题下的太阳（从 app/index.html 抄的；用来确认「参照物真的是太阳」）
const SUN_RAY_MARK = 'M12 2v2M12 20v2';

const profile = join(tmpdir(), 'echo-gear-profile');
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
  const J = (expr) => ev(`(async () => JSON.stringify(await (${expr})))()`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');

  // 先钉成浅色主题，再进页面 —— 否则量到的是月亮
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  await sleep(800);
  await ev(`localStorage.setItem('echolingo.theme', 'light')`);
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 150; i++) { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; await sleep(300); }
  await sleep(600);

  await ev(`window.__iconProbe = async (markup, sw, N) => {
    const withAttrs = markup.replace(/^<svg/,
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke="#000" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"');
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG 加载失败'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(withAttrs);
    });
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const on = new Uint8Array(N * N);
    let ink = 0;
    for (let i = 0; i < N * N; i++) { const a = d[i * 4 + 3]; if (a > 60) { on[i] = 1; ink++; } }

    // 外圈环带（0.60R ~ 0.80R）上的角度占用，720 格 = 每格 0.5°
    const R = N / 2, c = N / 2, BINS = 720, IN = 0.60, OUT = 0.80;
    const occ = new Uint8Array(BINS);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!on[y * N + x]) continue;
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const rr = Math.hypot(dx, dy) / R;
      if (rr < IN || rr > OUT) continue;
      let th = Math.atan2(dy, dx);
      if (th < 0) th += Math.PI * 2;
      occ[Math.min(BINS - 1, Math.floor(th / (Math.PI * 2) * BINS))] = 1;
    }
    let covered = 0;
    for (let i = 0; i < BINS; i++) covered += occ[i];

    // 环向连通段：从任意一个「空」格起绕一圈数，接缝自然被合并
    const runs = [];
    let empty = -1;
    for (let i = 0; i < BINS; i++) if (!occ[i]) { empty = i; break; }
    if (empty < 0) {
      runs.push(BINS);                     // 整圈无缝
    } else {
      let cur = 0;
      for (let k = 1; k <= BINS; k++) {
        if (occ[(empty + k) % BINS]) cur++;
        else { if (cur) runs.push(cur); cur = 0; }
      }
      if (cur) runs.push(cur);
    }
    runs.sort((a, b) => b - a);
    return {
      墨量: ink,
      环带角度覆盖率: +(covered / BINS).toFixed(4),
      环向连通段数: runs.length,
      最长连通段度数: +(360 * (runs[0] || 0) / BINS).toFixed(1),
      _mask: Array.from(on),
    };
  };
  window.__iou = (a, b) => {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x && y) inter++;
      if (x || y) uni++;
    }
    return +(inter / (uni || 1)).toFixed(4);
  };
  true;`);

  const probe = async (markup, sw, N = 480) => J(`window.__iconProbe(${JSON.stringify(markup)}, ${sw}, ${N})`);
  const live = async (sel) => J(`({
    markup: document.querySelector(${JSON.stringify(sel)}).outerHTML,
    strokeWidth: parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).strokeWidth)
  })`);

  const theme = await live('#btnTheme svg');
  const gear = await live('#btnSettings svg');
  // 参照物必须真的是太阳：浅色主题 + 有太阳射线那条 path
  const themeIsSun = theme.markup.includes(SUN_RAY_MARK);

  const mOld = await probe(OLD_SETTINGS, 1.7);
  const mSun = await probe(theme.markup, theme.strokeWidth);
  const mGear = await probe(gear.markup, gear.strokeWidth);

  const iouOldSun = await ev(`window.__iou(${JSON.stringify(mOld._mask)}, ${JSON.stringify(mSun._mask)})`);
  const iouGearSun = await ev(`window.__iou(${JSON.stringify(mGear._mask)}, ${JSON.stringify(mSun._mask)})`);

  const strip = (m) => ({ 墨量: m.墨量, 环带角度覆盖率: m.环带角度覆盖率, 环向连通段数: m.环向连通段数, 最长连通段度数: m.最长连通段度数 });

  /* ── 设置入口还得好用：点一下要能开 / 关抽屉 ── */
  const drawerBefore = await ev(`document.getElementById('setDrawer').hidden`);
  await ev(`document.querySelector('#btnSettings').click()`);
  await sleep(500);
  const drawerAfter = await ev(`document.getElementById('setDrawer').hidden`);
  await ev(`document.querySelector('#btnSettings').click()`);
  await sleep(400);

  const out = {
    '参照物确认（浅色主题的太阳）': themeIsSun,
    旧设置图标_改动前: strip(mOld),
    主题太阳图标: strip(mSun),
    新设置图标_齿轮: strip(mGear),
    'IoU 旧设置 × 太阳': iouOldSun,
    'IoU 新设置 × 太阳': iouGearSun,
    '齿轮的 stroke-width': gear.strokeWidth,
    '设置按钮还能开关抽屉': drawerBefore === true && drawerAfter === false,
    异常: errs.slice(0, 3),
  };
  console.log(JSON.stringify(out, null, 1));

  const checks = {
    '参照物确实是浅色主题的太阳（没量成月亮）': themeIsSun,
    '太阳/旧图标在外圈只是零散辐条（覆盖 < 55%）': mSun.环带角度覆盖率 < 0.55 && mOld.环带角度覆盖率 < 0.55,
    '太阳/旧图标没有任何一段绕得很长（最长 < 90°）': mSun.最长连通段度数 < 90 && mOld.最长连通段度数 < 90,
    // 齿轮的环带并不是「一整圈连续」，而是 8 段宽齿身（实测每段约 32°）；
    // 太阳是 8 段细辐条（约 13~14°）。所以判据是「每段宽了一倍以上」，不是「连成一圈」。
    '齿轮的每一段明显比辐条宽（最长 ≥ 2 倍）': mGear.最长连通段度数 >= mOld.最长连通段度数 * 2,
    '齿轮的环带覆盖明显高于旧图标（> 1.8 倍）': mGear.环带角度覆盖率 > mOld.环带角度覆盖率 * 1.8,
    '改动前设置图标和太阳高度重合（IoU > 0.45）': iouOldSun > 0.45,
    '改动后和太阳明显不再重合（IoU < 旧值的 0.7 倍）': iouGearSun < iouOldSun * 0.7,
    '齿轮没有糊成实心盘（墨量 < 旧图标 4 倍）': mGear.墨量 < mOld.墨量 * 4,
    '设置按钮仍然能开 / 关设置抽屉': out['设置按钮还能开关抽屉'] === true,
    '无 JS 异常': errs.length === 0,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n判定：');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  console.log(failed.length ? `\n✗ 设置图标有问题：${failed.join(' / ')}` : '\n✓ 设置图标已从「太阳」换成齿轮');
  ok = failed.length === 0;
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
