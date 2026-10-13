// Minimal Chrome DevTools Protocol driver (Node 22+ global WebSocket, zero deps).
// usage: node cdp.mjs <url> <expression-file>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const [url, exprFile] = process.argv.slice(2);
const expression = readFileSync(exprFile, 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'echolingo-bench-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-crash-reporter',
  '--disable-breakpad',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--mute-audio',
  '--window-size=1440,900',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 网络探针 ──
   只看 console 的进度文字判断不了「到底下了几遍、走的是缓存还是网络」：
   transformers 对同一个文件会报很多次同名进度，一次下载和一串重复下载
   在日志里长得一模一样。这里直接挂 CDP 的 Network 域，拿到每个请求的
   真实字节数，以及它是不是来自磁盘缓存 / Service Worker。 */
const NET = { req: new Map(), rows: [] };

function netEvent(m) {
  const p = m.params || {};
  if (m.method === 'Network.requestWillBeSent') {
    NET.req.set(p.requestId, { url: p.request?.url || '', ts: Date.now() });
  } else if (m.method === 'Network.responseReceived') {
    const e = NET.req.get(p.requestId);
    if (e) {
      e.status = p.response?.status;
      e.cache = !!p.response?.fromDiskCache;         // 磁盘缓存命中
      e.sw = !!p.response?.fromServiceWorker;
      e.prefetch = !!p.response?.fromPrefetchCache;
    }
  } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
    const e = NET.req.get(p.requestId);
    if (e) {
      e.bytes = p.encodedDataLength || 0;
      if (m.method === 'Network.loadingFailed') e.failed = p.errorText || 'failed';
      NET.rows.push(e);
      NET.req.delete(p.requestId);
    }
  }
}

const mb = (b) => (b / 1048576).toFixed(1) + 'MB';

/** 按路径汇总：请求次数、总字节、其中多少次是缓存命中的 */
function netTally() {
  const by = new Map();
  for (const r of [...NET.rows, ...NET.req.values()]) {
    let path;
    try { path = new URL(r.url).pathname; } catch { continue; }
    if (path === '/') continue;
    const g = by.get(path) || { path, n: 0, bytes: 0, cache: 0, sw: 0, failed: 0 };
    g.n++;
    g.bytes += r.bytes || 0;
    if (r.cache) g.cache++;
    if (r.sw) g.sw++;
    if (r.failed) g.failed++;
    by.set(path, g);
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes);
}

function printTally(limit = 30) {
  const rows = netTally();
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const models = rows.filter((r) => r.path.startsWith('/models/'));
  console.error('\n[net] ── 网络汇总（按字节降序，前 ' + limit + '） ──');
  for (const r of rows.slice(0, limit)) {
    console.error(`[net] ${mb(r.bytes).padStart(9)}  ×${String(r.n).padStart(2)}`
      + `  缓存命中${String(r.cache).padStart(2)}${r.sw ? ' SW' + r.sw : ''}`
      + `${r.failed ? ' 失败' + r.failed : ''}  ${r.path}`);
  }
  console.error(`[net] 模型目录合计 ${mb(models.reduce((s, r) => s + r.bytes, 0))}`
    + ` / ${models.reduce((s, r) => s + r.n, 0)} 个请求`);
  console.error(`[net] 全站合计 ${mb(total)}`);
}

async function waitForDevTools() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.onEvent = null; }
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
      } else if (m.method) {
        c.onEvent?.(m);
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

const main = async () => {
  await waitForDevTools();
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const cdp = await CDP.connect(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');       // 必须在导航之前开，否则漏掉首批请求
  cdp.onEvent = netEvent;

  // 在页面脚本之前注入一段代码。用来造出「二次访问」这类状态（例如先写
  // echolingo.asrCached），从而在同一份代码上做 A/B —— 比如量一量
  // 并发预取到底有没有拖慢识别。
  if (process.env.BENCH_INIT_JS) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: process.env.BENCH_INIT_JS });
  }

  await cdp.send('Page.navigate', { url });

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'window.__ready === true || document.readyState === "complete"',
      returnByValue: true,
    });
    if (r.result?.value) { ready = true; break; }
    await sleep(300);
  }
  if (!ready) throw new Error('页面未就绪');

  // 需要时把本地文件塞进页面的 file input（端到端跑真实视频用）
  if (process.env.BENCH_FILES) {
    const files = process.env.BENCH_FILES.split(',').map((s) => s.trim()).filter(Boolean);
    const selector = process.env.BENCH_SELECTOR || '#fileVideo';
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) throw new Error('找不到文件输入框：' + selector);
    await cdp.send('DOM.setFileInputFiles', { files, nodeId: q.nodeId });
  }

  // 「只看网络」模式：不跑表达式，等 N 毫秒后直接汇报流量账本。
  // 用来验证「首次访问到底下了多少、下了几遍」，不必等整条识别跑完（十几分钟）。
  if (process.env.BENCH_NET_MS) {
    await sleep(Number(process.env.BENCH_NET_MS));
    if (cdp.logs.length) console.error('[page] ' + cdp.logs.join('\n[page] '));
    const st = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ver: window.__ECHOLINGO_VER__, asrCached: !!localStorage.getItem("echolingo.asrCached"), mtCached: !!localStorage.getItem("echolingo.mtCached")})',
      returnByValue: true,
    });
    console.log(st.result?.value || '');
    printTally(40);
    chrome.kill('SIGKILL');
    process.exit(0);
  }

  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 900000,
  });
  if (r.exceptionDetails) {
    console.error('页面异常:', JSON.stringify(r.exceptionDetails, null, 2));
    if (cdp.logs.length) console.error('console:', cdp.logs.join('\n'));
    process.exitCode = 1;
  } else {
    if (cdp.logs.length) console.error('[page] ' + cdp.logs.join('\n[page] '));
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
  }
  printTally();
  chrome.kill('SIGKILL');
  process.exit(process.exitCode || 0);
};

main().catch((e) => { console.error('FAIL', e); chrome.kill('SIGKILL'); process.exit(1); });
