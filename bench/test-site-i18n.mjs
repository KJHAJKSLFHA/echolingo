// 独立的首页三语实测驱动（不依赖 bench/cdp.mjs 的上下文假设）。
// 用法: node bench/test-site-i18n.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9341);
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';

const profile = mkdtempSync(join(tmpdir(), 'echolingo-site-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio',
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function main() {
  // 等 CDP 起来
  let ver;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!ver) throw new Error('CDP 未就绪');

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');

  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push(d.exception?.description || d.text);
    }
  });

  await S('Page.navigate', { url: BASE });

  // 等 SITE_I18N 就位（比 readyState 靠谱：它就是我们要测的东西）
  let ok = false;
  for (let i = 0; i < 80; i++) {
    const r = await S('Runtime.evaluate', {
      expression: 'typeof window.SITE_I18N !== "undefined" && !!document.getElementById("langSeg")',
      returnByValue: true,
    });
    if (r.result?.value === true) { ok = true; break; }
    await sleep(150);
  }
  if (!ok) throw new Error('页面未就绪：SITE_I18N 或 langSeg 一直没出现');

  const r = await S('Runtime.evaluate', {
    expression: `(async () => { ${await (await import('node:fs/promises')).readFile(new URL('./site-i18n.expr.js', import.meta.url), 'utf8')} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    console.error('页面异常:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    const val = r.result.value;
    const data = typeof val === "string" ? JSON.parse(val) : val;

    for (const [l, info] of Object.entries(data.langs || {})) {
      console.log(`\n── ${l} ──`);
      console.log(`  html lang : ${info.htmlLang}`);
      console.log(`  title     : ${info.title.slice(0, 70)}`);
      console.log(`  desc      : ${info.desc}...`);
      console.log(`  已核对元素: ${info.checked}`);
      console.log(`  残留中文   : ${info.hanResidue}`);
      console.log(`  localStorage: ${info.saved}`);
      for (const p of info.problems) console.log(`  ✗ ${p}`);
      if (!info.problems.length) console.log('  ✓ 通过');
    }
    console.log(`\n收尾切回中文后 localStorage = ${data.remembered}`);
    console.log(data.ok ? '\n✓ 三语首页全部通过' : `\n✗ 共 ${data.problems.length} 个问题`);
    if (!data.ok) { console.log(data.problems.join('\n')); process.exitCode = 1; }
  }

  if (consoleErrors.length) {
    console.error('\n页面 JS 异常:');
    consoleErrors.forEach((e) => console.error('  ' + e.split('\n')[0]));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(() => { chrome.kill('SIGKILL'); process.exit(process.exitCode || 0); });
