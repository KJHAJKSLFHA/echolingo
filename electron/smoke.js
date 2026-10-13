// 临时冒烟测试入口：验证 Electron 桌面运行的关键项后自动退出。
// 只测小文件 + 关键环境标志，避免大 onnx 整份返回导致阻塞被杀。

'use strict';

const { app, BrowserWindow, Menu } = require('electron');
const { listen } = require('../server.js');

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { server, port } = await listen(0, '127.0.0.1');

  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const results = {};

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 2500));

  results.crossOriginIsolated = await win.webContents.executeJavaScript('self.crossOriginIsolated');
  results.hasSharedArrayBuffer = await win.webContents.executeJavaScript('typeof SharedArrayBuffer !== "undefined"');
  results.version = await win.webContents.executeJavaScript('window.__ECHOLINGO_VER__');
  results.hasPlayer = await win.webContents.executeJavaScript('!!document.getElementById("player")');
  // 小文件验证模型可达性（config.json 只有几 KB）
  results.modelConfig = await win.webContents.executeJavaScript(
    `fetch('/models/whisper-base.en/config.json').then(r => r.status).catch(e => 'ERR:' + e.message)`
  );
  // 验证 COOP/COEP 响应头是否真的下发了（用 HEAD 请求看 header）
  results.coopHeader = await win.webContents.executeJavaScript(
    `fetch('/models/whisper-base.en/config.json', {method:'HEAD'}).then(r => r.headers.get('cross-origin-embedder-policy')).catch(e => 'ERR:' + e.message)`
  );

  console.log('SMOKE_RESULT ' + JSON.stringify(results));

  const ok = results.crossOriginIsolated === true
    && results.hasSharedArrayBuffer === true
    && results.modelConfig === 200
    && results.coopHeader === 'require-corp';

  win.destroy();
  server.close();
  app.quit();
  process.exit(ok ? 0 : 1);
});
