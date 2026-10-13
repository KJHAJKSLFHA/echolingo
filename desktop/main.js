'use strict';

// EchoLingo 桌面版主进程。
//
// 结构很简单：先在 127.0.0.1 的**固定端口**上起一个静态服务器（见 site-server.js），
// 再用一个窗口加载它。之所以不直接 file:// 打开 index.html，原因写在
// site-server.js 的文件头：跨源隔离拿不到，wasm 多线程就废了。

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createSiteServer } = require('./site-server');

const BASE_PORT = Number(process.env.ECHOLINGO_PORT || 8731);
const PORT_TRIES = 10;

let mainWindow = null;
let server = null;

/** 站点根目录：打包后在 app/site，开发时是项目根 */
function siteRoot() {
  const packaged = path.join(__dirname, 'site');
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  return path.resolve(__dirname, '..');
}

function tryListen(s, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { s.removeListener('listening', onOk); reject(e); };
    const onOk = () => { s.removeListener('error', onError); resolve(port); };
    s.once('error', onError);
    s.once('listening', onOk);
    s.listen(port, '127.0.0.1');
  });
}

/** 优先用固定端口：来源稳定，收藏夹（IndexedDB）与离线缓存才不会每次启动就丢 */
async function startServer() {
  const s = createSiteServer(siteRoot());
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = BASE_PORT + i;
    try {
      await tryListen(s, port);
      if (i > 0) {
        console.warn(`[EchoLingo] 端口 ${BASE_PORT} 被占用，改用 ${port}。`
          + '注意：换端口等于换来源，收藏夹与离线缓存读不到上一次的。');
      }
      return { server: s, port };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`端口 ${BASE_PORT}~${BASE_PORT + PORT_TRIES - 1} 全部被占用`);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'EchoLingo',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 识别跑在前台，但用户很可能切去别的窗口干等。默认的后台节流会把
      // 定时器压到 1 秒一次，进度回调、段与段之间的调度全都会变慢。
      backgroundThrottling: false,
    },
  });

  // 首屏画好再显示，避免白闪
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);

  // 页内链接一律交给系统浏览器，别在应用窗口里跑
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith(url.split('#')[0].replace(/index\.html$/, ''))) return;
    if (/^https?:/i.test(target)) { e.preventDefault(); shell.openExternal(target); }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function buildMenu() {
  // 用系统标准菜单：Cmd+Q / Cmd+C / Cmd+V / 全屏 这些都得靠它
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

async function main() {
  buildMenu();
  let info;
  try {
    info = await startServer();
  } catch (e) {
    dialog.showErrorBox('无法启动本地服务', String(e && e.message || e));
    app.quit();
    return;
  }
  server = info.server;
  const url = `http://127.0.0.1:${info.port}/index.html`;
  console.info(`[EchoLingo] 本地服务已就绪 ${url}（站点根目录 ${siteRoot()}）`);
  createWindow(url);
}

// 单实例：第二次启动就把已有窗口拉到前面，而不是再起一个服务器
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(main);

  // macOS 习惯：关掉窗口不退出，点 Dock 图标再开一个。
  // 顺带的好处是关窗时渲染进程被销毁，几个识别会话占的内存会还回去。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      createWindow(`http://127.0.0.1:${server.address().port}/index.html`);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
