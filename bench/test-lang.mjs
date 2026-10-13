// 测右侧英文/中文的独立开关：按钮、快捷键、计算样式、提示条。
// usage: node bench/test-lang.mjs [port]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9555);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
async function cmd(method, params) {
  const i = ++id;
  const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
  return m.result;
}
const ev = async (e) => {
  const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

await cmd('Runtime.enable');
await cmd('DOM.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(1200);

// 导入示例字幕（自带中英双语），不用等识别
const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileSub' });
if (!q.nodeId) throw new Error('找不到 #fileSub');
await cmd('DOM.setFileInputFiles', { files: ['/Users/orion/WorkBuddy/2026-10-12-11-40-26/english-video-reader/media/demo.srt'], nodeId: q.nodeId });
for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('#subs .cue').length > 0`)) break; await sleep(300); }

const probe = () => ev(`(function(){
  const vis = (sel) => { const n = document.querySelector(sel); if (!n) return 'missing';
    return getComputedStyle(n).display === 'none' ? 'hidden' : 'shown'; };
  const btn = (lang) => { const b = document.querySelector('#langSeg button[data-lang="' + lang + '"]');
    return b ? (b.classList.contains('active') ? 'on' : 'off') : 'missing'; };
  return JSON.stringify({
    cues: document.querySelectorAll('#subs .cue').length,
    en: vis('#subs .cue-en'), zh: vis('#subs .cue-zh'),
    btnEn: btn('en'), btnZh: btn('zh'),
    bareClass: document.getElementById('subs').classList.contains('bare'),
    hintHidden: document.getElementById('bareHint')?.hidden
  });
})()`);

const out = { 初始: JSON.parse(await probe()) };

// 1) 点按钮关英文
await ev(`document.querySelector('#langSeg button[data-lang="en"]').click(); 1`);
await sleep(400);
out['点按钮关英文'] = JSON.parse(await probe());

// 2) 再点开
await ev(`document.querySelector('#langSeg button[data-lang="en"]').click(); 1`);
await sleep(400);
out['再点开英文'] = JSON.parse(await probe());

// 3) 快捷键 E 关英文
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); 1`);
await sleep(400);
out['快捷键E关英文'] = JSON.parse(await probe());

// 4) 快捷键 C 关中文 → 两边都关
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })); 1`);
await sleep(400);
out['再按C两边都关'] = JSON.parse(await probe());
writeFileSync('shots/lang-bare.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 5) 全部恢复
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })); 1`);
await sleep(400);
out['恢复'] = JSON.parse(await probe());

// 6) 关英文时的截图（练听力最常用的状态）
await ev(`document.querySelector('#langSeg button[data-lang="en"]').click(); 1`);
await sleep(500);
writeFileSync('shots/lang-zh-only.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 7) 中文也关掉时的截图
await ev(`document.querySelector('#langSeg button[data-lang="zh"]').click(); 1`);
await sleep(500);
writeFileSync('shots/lang-none.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 8) 设置是否持久化（读 localStorage）
out['持久化'] = JSON.parse(await ev(`(function(){
  const raw = localStorage.getItem('echolingo.settings.v1') || '{}';
  const s = JSON.parse(raw);
  return JSON.stringify({ showEn: s.showEn, showZh: s.showZh });
})()`));

// 9) 右侧面板截图（关英文、留中文）
await ev(`document.querySelector('#langSeg button[data-lang="en"]').click(); 1`);
await sleep(600);
const r = JSON.parse(await ev(`JSON.stringify((function(){const b=document.querySelector('.reader').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})())`));
writeFileSync('shots/lang-panel.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));

out.异常 = errs;
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
