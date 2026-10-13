// EchoLingo · Electron 主进程
//
// 为什么内嵌一个 HTTP 服务而不是直接 file:// 加载：
//   应用要跑 onnxruntime 的 wasm 后端，浏览器只有在 crossOriginIsolated 状态
//   （响应带 COOP/COEP 头）下才开放 SharedArrayBuffer，多线程推理才生效。
//   file:// 协议下没有这些头，wasm 会静默退化成单线程，识别慢成倍。
//   所以复用 server.js 的逻辑，在 127.0.0.1 上起一个随机端口的本地服务，
//   模型和 wasm 从本地磁盘读取，几乎零延迟 —— 这也顺带彻底解决了
//   「首次访问要下载 200MB 模型」的痛点（桌面版模型是随包打进去的）。
//
//   服务只监听回环地址，局域网其他设备访问不到，视频也从不离开本机。

'use strict';

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const { listen } = require('../server.js');

let mainWindow = null;
let appServer = null;
let serverPort = 0;

// 打包后资源在 app.asar 里，但 server.js 的 ROOT 用的是 __dirname，
// 这里不额外指定，让它继续指向项目根（打包后即 asar 内的根）。
const INDEX_URL = () => `http://127.0.0.1:${serverPort}/`;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'EchoLingo · 回声英语',
    backgroundColor: '#ffffff',
    show: false,               // 等服务就绪再显示，避免白屏一闪
    webPreferences: {
      // 同源 HTTP + COOP/COEP 头即可获得 crossOriginIsolated，
      // 不需要打开 nodeIntegration / contextIsolation 开关。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接用系统浏览器打开，不在应用内跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(INDEX_URL());
}

async function start() {
  // 起本地服务（随机端口，避免与用户其他程序冲突）
  const { server, port } = await listen(0, '127.0.0.1');
  appServer = server;
  serverPort = port;
  console.log(`[EchoLingo] 本地服务已启动 http://127.0.0.1:${port}/`);

  await createWindow();
}

// ── 应用生命周期 ──
app.whenReady().then(() => {
  // 去掉默认菜单栏里那些对纯前端应用没意义的项（如「重新加载」「开发者工具」在
  // 生产包里保留反而多余，但保留会方便排查 —— 这里保留标准菜单，仅隐藏）。
  Menu.setApplicationMenu(null);

  start().catch((e) => {
    console.error('[EchoLingo] 启动失败', e);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) start();
  });
});

app.on('window-all-closed', () => {
  // macOS 惯例：关闭窗口不退出应用，点 Dock 图标再开
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (appServer) {
    try { appServer.close(); } catch { /* 忽略 */ }
    appServer = null;
  }
});
