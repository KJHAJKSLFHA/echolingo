'use strict';

// EchoLingo 桌面版主进程。
//
// 结构很简单：先在 127.0.0.1 的**固定端口**上起一个静态服务器（见 site-server.js），
// 再用一个窗口加载它。之所以不直接 file:// 打开 index.html，原因写在
// site-server.js 的文件头：跨源隔离拿不到，wasm 多线程就废了。
//
// 2026-10 新增「平板可访问」开关：iPad / 安卓平板装不了 Electron 程序，
// 所以改由平板浏览器打开电脑上的这个站点。开关打开时监听地址从 127.0.0.1
// 换成 0.0.0.0，电脑自己的窗口仍然走 127.0.0.1（那边才有跨源隔离）。

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSiteServer } = require('./site-server');

const BASE_PORT = Number(process.env.ECHOLINGO_PORT || 8731);
const PORT_TRIES = 10;

let mainWindow = null;
let server = null;
let currentPort = BASE_PORT;

// 设置只有一项：局域网共享开着没有。存在 userData 里，跟着用户走。
const settings = { lan: false };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (typeof raw === 'object' && raw) {
      if (typeof raw.lan === 'boolean') settings.lan = raw.lan;
    }
  } catch { /* 首次启动没有这个文件，用默认值 */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    console.warn('[EchoLingo] 设置写不进去:', e && e.message);
  }
}

/** 站点根目录：打包后在 app/site，开发时是项目根 */
function siteRoot() {
  const packaged = path.join(__dirname, 'site');
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  return path.resolve(__dirname, '..');
}

/**
 * 能拿给平板用的地址。
 * 排除 loopback 与 169.254.*（链路本地，平板根本连不到），
 * 优先返回 192.168 / 10 / 172.16-31 这些典型内网段。
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  out.sort((x, y) => {
    const rank = (ip) => (/^192\.168\./.test(ip) ? 0
      : /^10\./.test(ip) ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    return rank(x) - rank(y);
  });
  return out;
}

function tryListen(s, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { s.removeListener('listening', onOk); reject(e); };
    const onOk = () => { s.removeListener('error', onError); resolve(port); };
    s.once('error', onError);
    s.once('listening', onOk);
    s.listen(port, host);
  });
}

/** 优先用固定端口：来源稳定，收藏夹（IndexedDB）与离线缓存才不会每次启动就丢 */
async function startServer(host) {
  const s = createSiteServer(siteRoot());
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = BASE_PORT + i;
    try {
      await tryListen(s, port, host);
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

/** 平板地址：随时可以从菜单里再查一次，省得用户忘了 */
function showLanInfo() {
  const addrs = lanAddresses();
  if (!settings.lan) {
    dialog.showMessageBox({
      type: 'info',
      message: '平板共享还没打开',
      detail: '要在 iPad 或安卓平板上用，先在菜单里勾上「让平板访问（局域网）」。',
      buttons: ['好'],
    });
    return;
  }
  if (!addrs.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: '没有找到局域网地址',
      detail: '电脑看起来没连 Wi-Fi 或有线网。连上之后重新勾一次菜单项。',
      buttons: ['好'],
    });
    return;
  }
  const urls = addrs.map((ip) => `http://${ip}:${currentPort}/`).join('\n');
  dialog.showMessageBox({
    type: 'info',
    message: '在平板浏览器里打开这个地址',
    detail: `${urls}\n\n`
      + '· 平板要和这台电脑连同一个 Wi-Fi。\n'
      + '· 第一次会加载识别与翻译模型，等一会儿。\n'
      + '· 平板上没有共享内存，识别是单线程跑，比电脑慢；导入链接取流仍然由这台电脑完成。\n'
      + '· 收藏和进度按设备分开存，平板和电脑各记各的。',
    buttons: ['好'],
  });
}

/** 切换监听地址。窗口始终留在 127.0.0.1，只有平板走局域网地址。 */
async function applyLanMode() {
  const host = settings.lan ? '0.0.0.0' : '127.0.0.1';
  const oldPort = currentPort;
  if (server) {
    await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
    server = null;
  }
  const info = await startServer(host);
  server = info.server;
  currentPort = info.port;
  console.info(`[EchoLingo] 监听 ${host}:${info.port}（平板共享${settings.lan ? '开' : '关'}）`);
  if (mainWindow && currentPort !== oldPort) {
    mainWindow.loadURL(`http://127.0.0.1:${currentPort}/index.html`);
  }
  return info;
}

function buildMenu() {
  // 用系统标准菜单：Cmd+Q / Cmd+C / Cmd+V / 全屏 这些都得靠它
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: '共享',
      submenu: [
        {
          label: '让平板访问（局域网）',
          type: 'checkbox',
          checked: settings.lan,
          click: async (item) => {
            settings.lan = item.checked;
            saveSettings();
            try {
              await applyLanMode();
            } catch (e) {
              item.checked = !item.checked;
              settings.lan = !settings.lan;
              saveSettings();
              dialog.showErrorBox('切换失败', String((e && e.message) || e));
              return;
            }
            if (settings.lan) showLanInfo();
          },
        },
        { label: '显示平板地址…', click: showLanInfo },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
  loadSettings();
  buildMenu();
  let info;
  try {
    info = await startServer(settings.lan ? '0.0.0.0' : '127.0.0.1');
  } catch (e) {
    dialog.showErrorBox('无法启动本地服务', String(e && e.message || e));
    app.quit();
    return;
  }
  server = info.server;
  currentPort = info.port;
  const url = `http://127.0.0.1:${info.port}/index.html`;
  console.info(`[EchoLingo] 本地服务已就绪 ${url}（站点根目录 ${siteRoot()}）`);
  if (settings.lan) {
    const addrs = lanAddresses();
    console.info('[EchoLingo] 平板可访问：' + (addrs.map((ip) => `http://${ip}:${info.port}/`).join('  ') || '（没有局域网地址）'));
  }
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
