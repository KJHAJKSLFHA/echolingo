// 双主题实测：真实渲染 + 逐元素算对比度 + 暗影硬边检测 + 各宽度溢出。
//
// 用法:
//   node bench/test-theme-contrast.mjs                 # 默认 http://127.0.0.1:8910
//   URL_BASE=http://127.0.0.1:8765 node bench/test-theme-contrast.mjs
//   VERBOSE=1 ... node bench/test-theme-contrast.mjs   # 打印每条断言（含通过的）
//
// 环境变量:
//   URL_BASE   被测站点根地址（默认 http://127.0.0.1:8910）
//   CDP_PORT   调试端口（默认 9547）
//   CHROME_BIN 浏览器可执行文件（默认 Microsoft Edge）
//
// ─────────────────────────────────────────────────────────────────────────
// 【重要 · 清理约定】
// 本脚本使用独立的 --user-data-dir（前缀 echolingo-theme-）启动 headless 实例，
// 并在启动前/退出时**只清理属于本脚本的残留实例**。
//
// 千万不要用 `pkill -f "Microsoft Edge"` 这类宽泛匹配去清场 ——
// 它会把用户正在使用的 Edge 窗口一起杀掉，并留下残留的 SingletonLock，
// 导致用户再点图标时「打不开」。需要清理就直接重跑本脚本。
// ─────────────────────────────────────────────────────────────────────────
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.CHROME_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = Number(process.env.CDP_PORT || 9547);
const BASE = process.env.URL_BASE || 'http://127.0.0.1:8910';
const UDD_PREFIX = 'echolingo-theme-';           // 只与自己的实例匹配，绝不动用户的浏览器
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, '.verify-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 只杀 cmdline 里含 UDD_PREFIX 的进程（即本脚本此前的残留实例）。
function sweepStale() {
  let n = 0;
  try {
    const out = execSync(`pgrep -f "${UDD_PREFIX}"`, { encoding: 'utf8' });
    for (const s of out.trim().split('\n')) {
      const pid = Number(s);
      if (!pid || pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); n++; } catch {}
    }
  } catch { /* pgrep 无匹配时退出码非 0，属正常 */ }
  return n;
}
const swept = sweepStale();

// 等到页面确实落在被测域的 http(s) 页面上。
// 否则 Page.navigate 还没生效时执行 localStorage 会报
// SecurityError: Access is denied for this document（about:blank）。
async function waitForOrigin(c, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const u = await c.ev('location.href');
    if (typeof u === 'string' && u.startsWith('http')) return u;
    await sleep(250);
  }
  throw new Error('页面始终没有导航到被测地址，检查 URL_BASE 与服务是否在跑');
}

if (swept) console.log(`[cleanup] 清理了 ${swept} 个上次残留的测试实例`);

async function getWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await new Promise((res, rej) => {
        http.get(`http://127.0.0.1:${PORT}/json/list`, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
      });
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp');
}
class C {
  constructor(w) { this.ws = w; this.id = 0; this.p = new Map(); this.ev2 = []; }
  static async conn(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new C(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && c.p.has(m.id)) { const { res, rej } = c.p.get(m.id); c.p.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      else if (m.method) c.ev2.push(m);
    };
    return c;
  }
  send(me, pa = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: me, params: pa })); }); }
  async ev(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const udd = join(tmpdir(), UDD_PREFIX + Date.now());
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let pass = 0, total = 0;
const ok = (n, p, d = '') => { total++; if (p) pass++; if (!p || process.env.VERBOSE) console.log(`  ${p ? '✓' : '✗'} ${n}${d ? '  → ' + d : ''}`); };

try {
  const c = await C.conn(await getWs());
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Network.enable');
  await c.send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);
  // about:blank 上读 localStorage 会 SecurityError。确认真的落在目标页再往下走。
  await waitForOrigin(c);

  console.log('=== 1. 三态切换：状态 / 令牌 / 图标 ===');
  for (const [pref, expEff, expBg, expIcon] of [['light', 'light', 'rgb(244, 248, 251)', 'i-sun'], ['dark', 'dark', 'rgb(6, 20, 32)', 'i-moon']]) {
    await c.ev(`(()=>{localStorage.setItem('echolingo.site.theme','${pref}');return 1})()`);
    await c.send('Page.navigate', { url: BASE + '/' }); await sleep(2200);
    const s = await c.ev(`(()=>{
      const h=document.documentElement, cs=getComputedStyle(document.body);
      const ic=[...document.querySelectorAll('#btnTheme svg')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.className.baseVal);
      const btn=document.getElementById('btnTheme');
      return {pref:h.dataset.themePref, eff:h.dataset.theme, bg:cs.backgroundColor, icon:ic, title:btn.title, aria:btn.getAttribute('aria-label')};
    })()`);
    ok(`${pref}: data-theme-pref`, s.pref === pref, s.pref);
    ok(`${pref}: data-theme=${expEff}`, s.eff === expEff, s.eff);
    ok(`${pref}: body 底色`, s.bg === expBg, s.bg);
    ok(`${pref}: 只显示 ${expIcon}`, s.icon.length === 1 && s.icon[0] === expIcon, JSON.stringify(s.icon));
    ok(`${pref}: 按钮提示`, /外观|Appearance|Aspecto/.test(s.title), s.title);
  }

  console.log('\n=== 2. 逐元素对比度（真实渲染像素合成）===');
  for (const pref of ['dark', 'light']) {
    await c.ev(`localStorage.setItem('echolingo.site.theme','${pref}')`);
    await c.send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
    const rows = await c.ev(`(async()=>{
      const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
      const cr=(a,b)=>{const la=lum(a),lb=lum(b);return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05)};
      const px=(s)=>{const m=s.match(/[\\d.]+/g).map(Number);return m.slice(0,3)};
      const blend=(top,bg,a)=>top.map((v,i)=>Math.round(v*a+bg[i]*(1-a)));
      // 取元素背后真正合成出来的底色：逐层往上累加带 alpha 的背景
      function bgOf(el){
        const stack=[]; let n=el;
        while(n&&n!==document.documentElement){const cs=getComputedStyle(n);
          if(cs.backgroundColor&&cs.backgroundColor!=='rgba(0, 0, 0, 0)')stack.push(cs.backgroundColor);n=n.parentElement;}
        stack.push(getComputedStyle(document.body).backgroundColor);
        let out=[6,20,32];
        for(let i=stack.length-1;i>=0;i--){const m=stack[i].match(/[\\d.]+/g).map(Number);
          const a=m.length>3?m[3]:1; out=blend(m.slice(0,3),out,a);}
        return out;
      }
      const sels=[['h1','主标题'],['.hero .lede','副标题'],['.badge','小徽章'],['.hero .hint','CTA 说明'],
                  ['.card h3','卡片标题'],['.card p','卡片正文'],['footer p','页脚'],['.nav a','导航链接']];
      const out=[];
      for(const [s,name] of sels){const el=document.querySelector(s); if(!el)continue;
        const cs=getComputedStyle(el); const fg=px(cs.color); const bg=bgOf(el);
        out.push({name, fg:cs.color, bg:'rgb('+bg.join(', ')+')', r:+cr(fg,bg).toFixed(2), size:cs.fontSize});}
      return out;
    })()`);
    console.log(`  ── ${pref} ──`);
    for (const r of rows) ok(`${r.name} ${r.size}`, r.r >= 4.5, `${r.r}:1  ${r.fg} on ${r.bg}`);
  }

  console.log('\n=== 3. 暗影硬边检测（用户反馈的问题）===');
  for (const pref of ['dark', 'light']) {
    await c.ev(`localStorage.setItem('echolingo.site.theme','${pref}')`);
    await c.send('Page.navigate', { url: BASE + '/' }); await sleep(2200);
    // 页面里是否还有 scrim；以及是否有 fixed 定位的暗色矩形
    const r = await c.ev(`(()=>{
      const scrim=document.querySelectorAll('.scrim');
      const veil=document.querySelector('.sea-veil');
      const veCS=veil?getComputedStyle(veil):null;
      return { scrim:scrim.length, veilBg: veCS?veCS.backgroundImage.slice(0,90):null };
    })()`);
    ok(`${pref}: 没有 .scrim 元素`, r.scrim === 0, `找到 ${r.scrim} 个`);
    ok(`${pref}: 压暗层是单向渐变（无硬边）`, /linear-gradient/.test(r.veilBg || ''), (r.veilBg || '').slice(0, 60));
  }

  console.log('\n=== 4. 响应式：六个宽度无横向溢出 ===');
  for (const [w, h] of [[1440, 900], [1024, 800], [820, 900], [520, 900], [390, 844], [360, 780]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(500);
    const r = await c.ev(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
    ok(`${w}x${h}`, r.sw <= r.cw, `scrollWidth=${r.sw} clientWidth=${r.cw}`);
  }
  await c.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n=== 5. 三语未破坏 ===');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const l of ['zh', 'en', 'es']) {
    await c.send('Page.navigate', { url: BASE + '/?lang=' + l }); await sleep(1800);
    await c.ev(`(()=>{const b=document.querySelector('[data-lang-btn="${l}"]'); if(b)b.click(); return 1})()`);
    await sleep(500);
    const r = await c.ev(`(()=>{const t=document.querySelector('#btnTheme'); const h=document.querySelector('h1');
      const miss=[...document.querySelectorAll('[data-i18n]')].filter(e=>!e.textContent.trim()).length;
      return {title:t.title, h1:(h?h.textContent:'').slice(0,26), miss}})()`);
    ok(`${l} 语言`, r.miss === 0 && r.h1.length > 0, `${r.h1} · ${r.title} · 漏翻 ${r.miss}`);
  }

  console.log('\n=== 6. 截图 ===');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const pref of ['dark', 'light']) {
    await c.ev(`localStorage.setItem('echolingo.site.theme','${pref}')`);
    await c.send('Page.navigate', { url: BASE + '/' }); await sleep(2500);
    const s = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT_DIR}/theme-${pref}.png`, Buffer.from(s.data, 'base64'));
    ok(`${pref} 首屏截图`, true, `.verify-shots/theme-${pref}.png`);
  }

  const errs = c.ev2.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
  ok('全程无 JS 异常', errs.length === 0, errs.map(e => e.params.entry.text).join('|').slice(0, 200));
  console.log(`\n===== ${pass}/${total} 通过 =====`);
} catch (e) {
  console.error('异常:', e.message);
  process.exitCode = 1;
} finally {
  try { proc.kill('SIGKILL'); } catch {}
  sweepStale();                                  // 兜底：连子进程（Helper）一起收掉
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
}
