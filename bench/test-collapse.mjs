// 测右侧面板的收起/展开：把手、宽度变化、持久化、快捷键，以及遮罩是否跟着重算。
// usage: node bench/test-collapse.mjs [port]
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

// 导入示例字幕，让右侧有内容
const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileSub' });
await cmd('DOM.setFileInputFiles', { files: ['/Users/orion/WorkBuddy/2026-10-12-11-40-26/english-video-reader/app/media/demo.srt'], nodeId: q.nodeId });
for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('#subs .cue').length > 0`)) break; await sleep(300); }

const probe = () => ev(`(function(){
  const r = document.querySelector('.reader');
  const rail = document.getElementById('readerRail');
  const stage = document.querySelector('.stage');
  const rr = r.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  return JSON.stringify({
    收起class: r.classList.contains('collapsed'),
    面板宽: Math.round(rr.width),
    视频区宽: Math.round(sr.width),
    把手文字: rail ? rail.textContent : 'missing',
    把手可见: rail ? getComputedStyle(rail).display !== 'none' : false,
    把手竖排: rail ? getComputedStyle(rail).writingMode : '',
    正文可见: getComputedStyle(document.getElementById('subs')).display !== 'none',
    提示条可见: getComputedStyle(document.getElementById('bareHint')).display !== 'none'
  });
})()`);

const out = { 展开时: JSON.parse(await probe()) };

// 1) 点把手收起
await ev(`document.getElementById('readerRail').click(); 1`);
await sleep(600);
out['点把手收起'] = JSON.parse(await probe());
writeFileSync('shots/collapse-on.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 2) 收起后视频区是否变大 → 检查视频内容区与遮罩位置
out['收起后几何'] = JSON.parse(await ev(`(function(){
  const v = document.getElementById('player');
  const r = v.getBoundingClientRect();
  const mA = v.videoWidth / v.videoHeight, cA = r.width / r.height;
  let cw, ch; if (mA > cA) { cw = r.width; ch = cw / mA; } else { ch = r.height; cw = ch * mA; }
  return JSON.stringify({ videoW: Math.round(r.width), videoH: Math.round(r.height), contentH: Math.round(ch) });
})()`));

// 3) 再点展开
await ev(`document.getElementById('readerRail').click(); 1`);
await sleep(600);
out['再点展开'] = JSON.parse(await probe());

// 4) 快捷键 H
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true })); 1`);
await sleep(500);
out['快捷键H收起'] = JSON.parse(await probe());
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true })); 1`);
await sleep(500);
out['再按H展开'] = JSON.parse(await probe());

// 5) 收起状态下的截图（用于预览）
await ev(`document.getElementById('readerRail').click(); 1`);
await sleep(700);
writeFileSync('shots/collapse-full.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 6) 持久化
out['持久化'] = JSON.parse(await ev(`(function(){
  const s = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
  return JSON.stringify({ readerCollapsed: s.readerCollapsed });
})()`));

// 7) 刷新后是否还记得（这才是持久化的真验证）
await cmd('Page.reload', { ignoreCache: true });
for (let i = 0; i < 100; i++) { await sleep(300); try { if (await ev(`document.querySelectorAll('#setAsrModel option').length > 0`)) break; } catch {} }
await sleep(800);
out['刷新后'] = JSON.parse(await probe());

// 恢复展开并保存
await ev(`(function(){ const r = document.querySelector('.reader'); if (r.classList.contains('collapsed')) document.getElementById('readerRail').click(); return 1; })()`);
await sleep(600);
out.恢复后 = JSON.parse(await probe());

out.异常 = errs;
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
