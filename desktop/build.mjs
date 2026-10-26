// 把站点 + Electron 主程序打成一个自包含的安装包
//
//   node build.mjs                        # 打当前平台当前架构（Apple Silicon 上是 macOS arm64）
//   ARCH=x64 node build.mjs               # macOS 需要 Intel 版时
//   TARGET=win node build.mjs             # 打 Windows x64 版
//   TARGET=mac ARCH=x64 node build.mjs    # 打 macOS Intel 版
//   ELECTRON_VERSION=44.7.0 node build.mjs
//
// 产物：
//   dist/EchoLingo.app                               （macOS）
//   dist/EchoLingo-win32-x64/EchoLingo.exe           （Windows，绿色版目录）
//   以及 download/files/ 下对应平台的 zip（下载页直接链这个）
//
// ── 为什么不用 @electron/packager ──
//
// packager 依赖 @electron/get + @electron-internal/extract-zip，后者是个
// napi-rs 原生模块。在 macOS 27 上加载它会直接被库校验拒掉：
//
//   dlopen(...index.darwin-universal.node): code signature ...
//   not valid for use in process: mapping process and mapped file
//   (non-platform) have different Team IDs
//
// 也就是说 Node 进程和那个 .node 的 Team ID 不一致，系统不允许加载。
// 这条链（electron/install.js 解压、packager 解压）在本机会全部失败。
//
// 而 zip 本身的下载是好的。所以这里干脆不依赖任何 npm 包：
//   · 自己用 fetch 下 Electron 的 zip（带镜像回退）
//   · 用系统的 ditto 解压 / 打包（macOS 原生，处理签名/扩展属性最稳）
//   · 手工组装目录（改名、改 Info.plist、放 app 与图标）
//   · macOS 最后 ad-hoc 重新签名 —— Apple Silicon 上不签名根本起不来，
//     而且往 bundle 里塞东西后 Electron 官方签名必然失效。
//
// 结果是 build.mjs 零依赖，只要系统有 node 和 macOS 自带的 ditto/plutil/codesign。
//
// ── Windows 是在 macOS 上交叉打的 ──
//
// Electron 的 win32 zip 本身就是绿色版，解压即用，不需要 wine 或
// electron-builder。我们把 resources/app 换成自己的代码、把 yt-dlp.exe 与
// ffmpeg.exe 放进 resources/bin，然后压成 zip —— 用户解压双击就能跑，
// 不写注册表、不用安装程序。

import { createWriteStream } from 'node:fs';
import fsSync from 'node:fs';
import { cp, mkdir, rm, writeFile, readFile, access, stat, rename, chmod, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 报错时提示这个文件是从哪儿来的（uv/pip 装的都是脚本壳） */
function sourceHint(src) {
  if (src.includes('/uv/tools/')) return 'uv 装的 yt-dlp';
  if (src.includes('/Cellar/')) return 'brew 装的';
  if (src.includes('/site-packages/') || src.includes('/bin/python')) return 'pip 装的';
  return src;
}

/** 在 PATH 里找可执行文件（打包取流二进制用，零依赖） */
function whichSync(name) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...String(process.env.PATH || '').split(path.delimiter),
  ];
  for (const d of dirs) {
    if (!d) continue;
    const full = path.join(d, name);
    try { if (fsSync.statSync(full).isFile()) return full; } catch { /* 下一个 */ }
  }
  return '';
}
const PROJECT = path.resolve(__dirname, '..');
const STAGE = path.join(__dirname, '.stage');
const CACHE = path.join(__dirname, '.electron-cache');
const DIST = path.join(PROJECT, 'dist');
const DOWNLOADS = path.join(PROJECT, 'download', 'files');

const TARGET = (process.env.TARGET || (process.platform === 'win32' ? 'win' : 'mac')).toLowerCase();
const ARCH = process.env.ARCH || process.arch;
const ELECTRON_VERSION = process.env.ELECTRON_VERSION || '44.7.0';
// BUILD=fetchd 打的是「取流助手」：只有本机取流服务 + yt-dlp + ffmpeg，
// 不带站点、不带识别模型，体积从 900 MB 降到一百多 MB。
// 它的使用者是「别人的电脑」——只想在网页版里导入链接的人。
const FETCHD = process.env.BUILD === 'fetchd';
const APP_ID = FETCHD ? 'com.echolingo.fetchd' : 'com.echolingo.desktop';
const PRODUCT = FETCHD ? 'EchoLingoHelper' : 'EchoLingo';
const APP_NAME_ZH = FETCHD ? '取流助手' : 'EchoLingo';

if (TARGET !== 'mac' && TARGET !== 'win') {
  console.error(`TARGET 只能是 mac 或 win，收到 ${TARGET}`);
  process.exit(1);
}

// Electron 的平台标签：darwin-arm64 / darwin-x64 / win32-x64
const PLATFORM_TAG = TARGET === 'win' ? 'win32-x64' : `darwin-${ARCH}`;
const ELECTRON_DIR_NAME = TARGET === 'win' ? `${PRODUCT}-win32-x64` : `${PRODUCT}.app`;
const OUT_DIR = path.join(DIST, ELECTRON_DIR_NAME);

// 镜像优先（国内快），失败再回官方 GitHub
const ZIP_URLS = [
  `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-${PLATFORM_TAG}.zip`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-${PLATFORM_TAG}.zip`,
];

// 工具本体在 app/ 下（仓库根目录留给了产品官网首页）。
// 桌面版直接把 app/ 的内容铺成站点根目录，所以窗口打开的是工具本身，
// 不是官网首页 —— 装了 App 的人不该先看一遍介绍页。
const SITE_SRC = path.join(PROJECT, 'app');

// 站点真正需要的东西。bench/（测试脚本）、tools/、desktop/、shots/ 一律不进包。
const SITE_ENTRIES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'vendor',
  'models',
  'dict',
  'media',
];

// 取流用的外部程序。Windows 上必须带 .exe 后缀 ——
// url-import.js 的 findBin() 在 win32 下会自己补 .exe，所以放原名即可。
const NEEDS_BIN = [
  { key: 'yt-dlp', env: 'ECHOLINGO_YTDLP' },
  { key: 'ffmpeg', env: 'ECHOLINGO_FFMPEG' },
];

const human = (b) => (b / 1048576).toFixed(0) + ' MB';

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function pathSize(p) {
  const { stdout } = await run('du', ['-sk', p]);
  return Number(stdout.split(/\s+/)[0]) * 1024;
}

async function appVersion() {
  // 工具本体在 app/ 下（仓库根目录留给了产品官网首页）
  const src = await readFile(path.join(SITE_SRC, 'js', 'app.js'), 'utf8');
  const m = src.match(/APP_VER\s*=\s*'([^']+)'/);
  return m ? m[1] : '1.0.0';
}

/** 下载 Electron zip；已缓存就直接用。ECHOLINGO_ELECTRON_ZIP 可直接指定本地 zip。 */
async function ensureZip() {
  await mkdir(CACHE, { recursive: true });
  const zip = path.join(CACHE, `electron-v${ELECTRON_VERSION}-${PLATFORM_TAG}.zip`);
  if (await exists(zip)) {
    console.log(`  Electron zip 已缓存 ${human((await stat(zip)).size)}`);
    return zip;
  }
  const given = process.env.ECHOLINGO_ELECTRON_ZIP;
  if (given) {
    const real = path.resolve(given);
    if (!(await exists(real))) throw new Error(`ECHOLINGO_ELECTRON_ZIP 指向的文件不存在：${real}`);
    console.log(`  使用指定的 zip：${real}`);
    await cp(real, zip);
    return zip;
  }

  const tmp = zip + '.part';
  let lastErr;
  for (const url of ZIP_URLS) {
    try {
      console.log(`  下载 ${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let lastPct = -1;
      const body = Readable.fromWeb(res.body);
      body.on('data', (c) => {
        got += c.length;
        if (!total) return;
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`    ${pct}%\r`); }
      });
      await pipeline(body, createWriteStream(tmp));
      process.stdout.write('    ');
      if (total && got !== total) throw new Error(`大小不符：收到 ${got} / 期望 ${total}`);
      await rename(tmp, zip);
      console.log(`  下载完成 ${human(got)}`);
      return zip;
    } catch (e) {
      lastErr = e;
      console.warn(`  失败：${e.message}，换下一个源`);
      await rm(tmp, { force: true });
    }
  }
  throw new Error(`Electron 下载失败：${lastErr && lastErr.message}`);
}

/** 改 Info.plist：存在就 replace，不存在就 insert */
async function plistSet(plist, key, value) {
  const type = typeof value === 'number' ? 'integer' : 'string';
  try {
    await run('plutil', ['-replace', key, '-' + type, String(value), plist]);
  } catch {
    await run('plutil', ['-insert', key, '-' + type, String(value), plist]);
  }
}

/**
 * 应用本体：<resources>/app/{package.json,main.js,site-server.js,url-import.js,site/}
 * macOS 与 Windows 用的是同一套布局（只在 resources 目录的位置上不同）。
 */
async function stageApp(resources, version) {
  const appDir = path.join(resources, 'app');
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  for (const f of ['main.js', 'site-server.js']) {
    await cp(path.join(__dirname, f), path.join(appDir, f));
  }
  // 取流接口模块：跟着应用本体走，桌面版和网页版共用同一份实现
  await cp(path.join(__dirname, '..', 'url-import.js'), path.join(appDir, 'url-import.js'));
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'echolingo',
    productName: PRODUCT,
    version,
    description: 'EchoLingo 回声语言 — 纯离线英语/西语视频精读',
    main: 'main.js',
    license: 'MIT',
  }, null, 2) + '\n');

  const siteDir = path.join(appDir, 'site');
  await mkdir(siteDir, { recursive: true });
  for (const entry of SITE_ENTRIES) {
    const from = path.join(SITE_SRC, entry);
    if (!(await exists(from))) { console.warn(`  跳过不存在的条目: ${entry}`); continue; }
    await cp(from, path.join(siteDir, entry), { recursive: true });
  }
  // 下载页也带一份：首页顶栏有「取流助手」链接，包里缺这一页就会 404。
  // 只拷 index.html —— download/files/ 是三个 0.5 GB 的安装包，不能进应用。
  const dlPage = path.join(SITE_SRC, '..', 'download', 'index.html');
  if (await exists(dlPage)) {
    const dlDir = path.join(siteDir, 'download');
    await mkdir(dlDir, { recursive: true });
    await cp(dlPage, path.join(dlDir, 'index.html'));
  }
  console.log(`  站点已就位 ${human(await pathSize(siteDir))}`);
  return appDir;
}

/**
 * 取流助手的应用本体：<resources>/app/{package.json,main.js,helper-server.js,url-import.js}
 *
 * 不带 site/、不带 models/ —— 它不加载任何页面，识别与翻译都在用户的浏览器里做。
 * 这正是它能把 900 MB 压到一百多 MB 的原因。
 */
async function stageFetchd(resources, version) {
  const appDir = path.join(resources, 'app');
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  for (const f of ['main.js', 'helper-server.js']) {
    await cp(path.join(PROJECT, 'fetchd', f), path.join(appDir, f));
  }
  // 取流实现与客户端/网页端共用同一份
  await cp(path.join(PROJECT, 'url-import.js'), path.join(appDir, 'url-import.js'));
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'echolingo-fetchd',
    productName: 'EchoLingo Fetchd',
    version,
    description: '取流助手：让 EchoLingo 网页版可以导入 YouTube / 哔哩哔哩 链接',
    main: 'main.js',
    license: 'MIT',
  }, null, 2) + '\n');

  // 菜单栏图标（主进程会缩到 18px）
  const icon = path.join(__dirname, 'icon-1024.png');
  if (await exists(icon)) await cp(icon, path.join(resources, 'icon.png'));
  console.log(`  取流助手已就位 ${human(await pathSize(appDir))}`);
  return appDir;
}

/** 按 BUILD 选应用本体 */
async function stagePayload(resources, version) {
  return FETCHD ? stageFetchd(resources, version) : stageApp(resources, version);
}

/**
 * 取流用的外部程序：装进 <resources>/bin，用户零配置。
 *   yt-dlp 负责下载，ffmpeg 负责合并音视频 / 转字幕格式。
 * 从哪儿取（按优先级）：
 *   1. desktop/vendor/<平台>/<name>  —— 交叉打包时放这儿（如 vendor/win/ffmpeg.exe）
 *   2. desktop/vendor/<name>         —— 单平台机器上放这儿
 *   3. 环境变量 ECHOLINGO_YTDLP / ECHOLINGO_FFMPEG
 *   4. PATH 里的同名程序
 * 为什么优先 vendor：本机 PATH 上的多半是 uv / pip / brew 的启动脚本或
 * 别的架构的二进制，拷进包里到别人机器上跑不起来。
 */
async function stageBins(resources, target) {
  const binDir = path.join(resources, 'bin');
  await mkdir(binDir, { recursive: true });
  const exe = target === 'win' ? '.exe' : '';

  for (const { key, env } of NEEDS_BIN) {
    const candidates = [
      path.join(__dirname, 'vendor', target === 'win' ? 'win' : 'mac', key + exe),
      path.join(__dirname, 'vendor', key + exe),
    ];
    let src = '';
    for (const c of candidates) {
      try { if ((await stat(c)).isFile()) { src = c; break; } } catch { /* 下一个 */ }
    }
    if (!src) src = process.env[env] || whichSync(key) || whichSync(key + exe);
    if (!src) {
      console.warn(`  没找到 ${key}，打出来的包不能从链接导入`);
      continue;
    }

    // dereference: 符号链接直接 cp 只会把链接本身拷进去
    const real = await realpath(src);
    // Windows 的 .exe 不可能带 shebang；macOS 上要挡一下 uv/pip 的脚本壳
    if (target !== 'win') {
      const head = (await readFile(real)).subarray(0, 2).toString('latin1');
      if (head === '#!') {
        console.warn(`  ${key} 是启动脚本（${sourceHint(src)}），不是独立可执行文件；`
          + ` 请把它放到 desktop/vendor/${key} 或用 ${env} 指定`);
        continue;
      }
    }
    const dst = path.join(binDir, key + exe);
    await cp(real, dst);
    if (target !== 'win') await chmod(dst, 0o755);
    console.log(`  ${key}${exe} 已装入 resources/bin ${human(await pathSize(real))}`);
  }
}

/**
 * 打 zip（macOS 的 ditto 会把权限位和符号链接一起带上）
 *
 * --sequesterRsrc 是关键：没有它，ditto 会把扩展属性写成跟真文件同级的
 * `._foo` AppleDouble 条目塞进 zip。解压后这些 `._` 文件就落在 bundle 里，
 * 而它们不在签名封条（_CodeSignature）的清单中 —— macOS 于是判定
 * 「a sealed resource is missing or invalid」，弹「已损坏，无法打开」。
 * 加了它，扩展属性会被收进 __MACOSX/，解压时由归档工具还原，不污染 bundle。
 */
async function zipDir(srcDir, dstZip) {
  await mkdir(path.dirname(dstZip), { recursive: true });
  await rm(dstZip, { force: true });
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', srcDir, dstZip], { maxBuffer: 1 << 26 });
  const size = (await stat(dstZip)).size;
  console.log(`  zip 已生成 ${path.relative(PROJECT, dstZip)} ${human(size)}`);
  return size;
}

/* ============================ macOS ============================ */

async function buildMac(version) {
  const zip = await ensureZip();
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  console.log('  解压 …');
  await run('ditto', ['-x', '-k', zip, STAGE], { maxBuffer: 1 << 26 });

  const srcApp = path.join(STAGE, 'Electron.app');
  if (!(await exists(srcApp))) throw new Error('解压后找不到 Electron.app');

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  console.log('  拷贝 Electron.app → EchoLingo.app');
  await run('ditto', [srcApp, OUT_DIR], { maxBuffer: 1 << 26 });

  const contents = path.join(OUT_DIR, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const plist = path.join(contents, 'Info.plist');

  // 改成自己的可执行文件名（Info.plist 里的 CFBundleExecutable 必须与之一致）
  if (await exists(path.join(macos, 'Electron'))) {
    await rename(path.join(macos, 'Electron'), path.join(macos, PRODUCT));
  }

  await plistSet(plist, 'CFBundleExecutable', PRODUCT);
  await plistSet(plist, 'CFBundleName', PRODUCT);
  await plistSet(plist, 'CFBundleDisplayName', PRODUCT);
  await plistSet(plist, 'CFBundleIdentifier', APP_ID);
  await plistSet(plist, 'CFBundleShortVersionString', version);
  await plistSet(plist, 'CFBundleVersion', version);
  await plistSet(plist, 'CFBundleIconFile', 'electron.icns');
  await plistSet(plist, 'NSHumanReadableCopyright', `Copyright © ${new Date().getFullYear()} EchoLingo`);

  // 图标：直接覆盖默认的 electron.icns，省得再动 plist 的取值
  const icon = path.join(__dirname, 'icon.icns');
  if (await exists(icon)) {
    await cp(icon, path.join(resources, 'electron.icns'));
  } else {
    console.warn('  没有 icon.icns，用 Electron 默认图标');
  }

  // 默认的欢迎页 app 不再需要；留着反而可能在被误调用时抢戏
  await rm(path.join(resources, 'default_app.asar'), { force: true });

  await stagePayload(resources, version);
  await stageBins(resources, 'mac');

  // ad-hoc 重签名。往 bundle 里塞了东西，Electron 官方那份签名已经失效；
  // 而 Apple Silicon 上签名无效的 arm64 应用会被系统直接拒绝启动。
  //
  // 签名前必须先清扩展属性：Electron 下载包里带了一堆 com.apple.* xattr
  // （含 quarantine），它们会被 ditto/zip 变成 `._` 文件；这些文件不在封条
  // 清单里，解压后 macOS 就报「已损坏」。清干净再签，签名才和内容一致。
  console.log('  清理扩展属性…');
  await run('xattr', ['-cr', OUT_DIR], { maxBuffer: 1 << 26 });
  await run('find', [OUT_DIR, '-name', '._*', '-delete'], { maxBuffer: 1 << 26 });

  console.log('  重新签名（ad-hoc）…');
  await run('codesign', ['--force', '--deep', '--sign', '-', OUT_DIR], { maxBuffer: 1 << 26 });
  await run('codesign', ['--verify', '--deep', '--strict', OUT_DIR], { maxBuffer: 1 << 26 });
  console.log('  签名校验通过');

  await rm(STAGE, { recursive: true, force: true });

  const zipName = FETCHD ? `FetchdHelper-macOS-${ARCH}.zip` : `EchoLingo-macOS-${ARCH}.zip`;
  const zipPath = path.join(DOWNLOADS, zipName);
  await zipDir(OUT_DIR, zipPath);

  // 出包后自检：zip 里不能再有 `._` AppleDouble 条目，否则用户解压后又报「已损坏」。
  // __MACOSX/ 下面的除外 —— 那是 --sequesterRsrc 的合法产物，解压时会被还原成
  // 扩展属性而不落进 bundle。
  const { stdout: listing } = await run('zipinfo', ['-1', zipPath], { maxBuffer: 1 << 28 });
  const junk = listing.split('\n')
    .filter((n) => !n.startsWith('__MACOSX/'))
    .filter((n) => /(^|\/)\._/.test(n));
  if (junk.length) {
    throw new Error(`zip 里混进了 ${junk.length} 个 ._ 文件（首个：${junk[0]}），解压后会报「已损坏」`);
  }
  console.log('  zip 自检通过：无 ._ 污染');
  return zipPath;
}

/* =========================== Windows =========================== */

async function buildWin(version) {
  const zip = await ensureZip();
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  console.log('  解压 …');
  await run('ditto', ['-x', '-k', zip, STAGE], { maxBuffer: 1 << 26 });

  // Windows 的 Electron zip 是扁平的：electron.exe 就在顶层
  const srcExe = path.join(STAGE, 'electron.exe');
  if (!(await exists(srcExe))) throw new Error('解压后找不到 electron.exe');

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  console.log('  拷贝 Electron → EchoLingo-win32-x64');
  await run('ditto', [STAGE, OUT_DIR], { maxBuffer: 1 << 26 });

  // 可执行文件改名。Windows 上进程名直接决定任务管理器里显示什么、以及
  // 单实例锁的标识，所以不只是装样子。
  await rename(path.join(OUT_DIR, 'electron.exe'), path.join(OUT_DIR, PRODUCT + '.exe'));

  const resources = path.join(OUT_DIR, 'resources');
  await rm(path.join(resources, 'default_app.asar'), { force: true });

  await stagePayload(resources, version);
  await stageBins(resources, 'win');

  // Windows 没有 signing / 没有 plist 要改；exe 的版本信息留在 Electron 原样。
  await rm(STAGE, { recursive: true, force: true });

  const zipName = FETCHD ? 'FetchdHelper-Windows-x64.zip' : 'EchoLingo-Windows-x64.zip';
  await zipDir(OUT_DIR, path.join(DOWNLOADS, zipName));
  return path.join(DOWNLOADS, zipName);
}

/* ============================= 入口 ============================= */

async function main() {
  const version = await appVersion();
  console.log(`打包 ${PRODUCT} ${version}  target ${TARGET} (${PLATFORM_TAG})  electron ${ELECTRON_VERSION}`);

  const out = TARGET === 'win' ? await buildWin(version) : await buildMac(version);

  console.log(`\n目录: ${path.relative(PROJECT, OUT_DIR)}  ${human(await pathSize(OUT_DIR))}`);
  console.log(`压缩包: ${path.relative(PROJECT, out)}`);
  if (TARGET === 'mac') console.log(`打开: open "${OUT_DIR}"`);
}

main().catch((e) => {
  console.error('打包失败:', e && e.message || e);
  process.exit(1);
});
