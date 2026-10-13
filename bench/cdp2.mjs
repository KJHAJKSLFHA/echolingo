// Minimal CDP driver — private copy on port 9444 so it cannot collide with the
// other session's bench/cdp.mjs (port 9333).
// usage: node bench/cdp2.mjs <url> <expression-file>
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;
const [url, exprFile] = process.argv.slice(2);
const expression = readFileSync(exprFile, 'utf8');
const profile = mkdtempSync(join(tmpdir(), 'echo-tsmode-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--mute-audio', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDevTools() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('devtools 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        c.logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

await waitDevTools();
const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const cdp = await CDP.connect(t.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url });

let ready = false;
for (let i = 0; i < 100; i++) {
  const r = await cdp.send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
  if (r.result?.value) { ready = true; break; }
  await sleep(300);
}
if (!ready) { console.error('页面未就绪'); chrome.kill('SIGKILL'); process.exit(1); }

const r = await cdp.send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true, returnByValue: true, timeout: 900000,
});
if (r.exceptionDetails) {
  console.error('页面异常:', JSON.stringify(r.exceptionDetails, null, 2));
  if (cdp.logs.length) console.error('[page] ' + cdp.logs.join('\n[page] '));
  process.exitCode = 1;
} else {
  if (cdp.logs.length) console.error('[page] ' + cdp.logs.join('\n[page] '));
  console.log(JSON.stringify(r.result.value, null, 2));
}
chrome.kill('SIGKILL');
process.exit(process.exitCode || 0);
