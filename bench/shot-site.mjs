// 给首页三种语言各截一张全页图，用来肉眼确认长文本（西语普遍比中文长）没有把布局撑坏。
// 用法: node bench/shot-site.mjs [baseUrl] [outDir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9342);
const BASE = process.argv[2] || 'http://127.0.0.1:8765/';
const OUT = process.argv[3] || 'shots/site-i18n';

mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'echolingo-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio',
  '--window-size=1440,1000', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pend = new Map();
const send = (method, params = {}, sessionId) => {
  const i = ++id;
  return new Promise((res, rej) => {
    pend.set(i, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });
};

async function main() {
  let ver;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Page.navigate', { url: BASE });
  await sleep(2500);

  for (const lang of ['zh', 'en', 'es']) {
    const r = await S('Runtime.evaluate', {
      expression: `(async () => {
        const b = document.querySelector('[data-lang-btn="${lang}"]');
        if (!b) return 'no button';
        b.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        // 全页高度要等图片布局完
        await new Promise(r => setTimeout(r, 600));
        return JSON.stringify({ lang: document.documentElement.lang, h: document.documentElement.scrollHeight });
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    const info = JSON.parse(r.result.value);

    const metrics = await S('Page.getLayoutMetrics');
    const cs = metrics.cssContentSize || metrics.contentSize;
    const shot = await S('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1440, height: Math.min(cs.height, 12000), scale: 1 },
      captureBeyondViewport: true,
    });
    const file = join(OUT, `home-${lang}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${lang}: html lang=${info.lang}  页面高=${info.h}px  → ${file}`);
  }
}

main()
  .catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(() => { chrome.kill('SIGKILL'); process.exit(process.exitCode || 0); });
