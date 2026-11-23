'use strict';
/**
 * Electron 主进程
 * - 创建窗口（深色主题、无边框自绘标题栏）
 * - 通过 IPC 暴露小黑盒 API（签名在 Node 侧完成，渲染进程拿不到签名逻辑）
 * - 自定义 hbimg:// 协议代理图片，绕过防盗链
 * - 配置（Cookie / deviceId）持久化到 userData
 */

const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const QRCode = require('qrcode');
const heybox = require('./src/heybox');

const isDev = process.argv.includes('--dev');

// 提高兼容性：虚拟机 / 远程桌面 / 驱动异常时 GPU 进程易崩溃，资讯类应用软件渲染足够
app.disableHardwareAcceleration();

/* ------------------------- 配置持久化 ------------------------- */

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
  return next;
}

/* ------------------------- 图片代理协议 ------------------------- */

// 允许的小黑盒图片域名（防盗链代理白名单）
const IMG_HOSTS = ['.xiaoheihe.cn', '.max-c.com', '.akamai.steamstatic.com'];

function isAllowedImage(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return IMG_HOSTS.some((h) => u.hostname === h.slice(1) || u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'hbimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

function registerImageProtocol() {
  protocol.handle('hbimg', async (req) => {
    try {
      const u = new URL(req.url);
      // hbimg://i/<encodeURIComponent(原始地址)>
      const target = decodeURIComponent(u.pathname.replace(/^\//, '') + u.search);
      if (!isAllowedImage(target)) return new Response('forbidden', { status: 403 });
      const res = await net.fetch(target, {
        headers: {
          Referer: 'https://www.xiaoheihe.cn/',
          'User-Agent': heybox.UA,
        },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return new Response(buf, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'max-age=3600',
        },
      });
    } catch {
      return new Response('proxy error', { status: 502 });
    }
  });
}

/* ------------------------- 窗口 ------------------------- */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#14151a',
    title: '黑盒社区',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  const sendMaxState = () =>
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  // 外链一律用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

/* ------------------------- IPC ------------------------- */

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: (err && err.message) || String(err) });

function setupIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, payload) => {
      try {
        return ok(await fn(payload || {}));
      } catch (e) {
        return fail(e);
      }
    });

  handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron }));

  // 配置
  handle('config:get', () => {
    const cfg = loadConfig();
    return {
      hasCookie: !!(cfg.cookie && cfg.cookie.trim()),
      deviceId: heybox.getState().deviceId,
      profile: cfg.profile || null,
      captchaCooldownMs: heybox.captchaCooldownRemainingMs(),
    };
  });

  handle('config:setCookie', ({ cookie }) => {
    const c = (cookie || '').trim();
    const hbId = heybox.extractHeyboxId(c);
    // 换了 Cookie 就把旧的资料缓存清掉，避免显示上一个账号
    saveConfig({ cookie: c, heyboxId: hbId || '0', profile: c ? null : null });
    heybox.configure({ cookie: c, heyboxId: hbId || '0' });
    heybox.resetCaptcha();
    return { hasCookie: !!c, heyboxId: hbId || '0' };
  });

  /* -------- 扫码登录 -------- */

  // 创建二维码：返回可渲染的 dataURL + 轮询 token
  handle('auth:qrCreate', async () => {
    const r = await heybox.createQrLogin();
    if (!r.ok) return r;
    // margin:4 保证二维码四周有足够静区（官方同款参数），过低会导致手机扫不上
    const qrDataUrl = await QRCode.toDataURL(r.url, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#14151aff', light: '#ffffffff' },
    });
    return { ok: true, token: r.token, expiresIn: r.expiresIn, qrDataUrl, url: r.url };
  });

  // 轮询二维码状态；成功后落盘 Cookie 并拉取资料
  handle('auth:qrPoll', async ({ token }) => {
    const r = await heybox.pollQrLogin(token);
    if (r.state !== 'succeeded') return r;

    saveConfig({ cookie: r.cookie, heyboxId: r.heyboxId, profile: r.profile || null });
    heybox.configure({ cookie: r.cookie, heyboxId: r.heyboxId });
    heybox.resetCaptcha();

    // 用登录态立即验证 + 拉取最新资料；失败不影响登录，但把原因带给 UI
    let profile = r.profile || null;
    let warn = r.warning || '';
    try {
      const p = await heybox.getProfile();
      if (p.ok) {
        profile = p.profile;
        warn = '';                      // 校验通过就以校验结果为准，忽略 pkey 提示
        saveConfig({ profile });
      } else if (!warn) {
        warn = `登录态已保存，但校验未通过（${p.message || '未知原因'}），部分功能可能不可用`;
      }
    } catch (e) {
      if (!warn) warn = `登录态已保存，但资料拉取失败：${e.message}`;
    }
    return { state: 'succeeded', heyboxId: r.heyboxId, profile, warn };
  });

  handle('auth:profile', async () => {
    const p = await heybox.getProfile();
    if (p.ok) saveConfig({ profile: p.profile });
    return p;
  });

  handle('auth:logout', () => {
    saveConfig({ cookie: '', profile: null, heyboxId: '0' });
    heybox.configure({ cookie: '', heyboxId: '0' });
    heybox.resetCaptcha();
    return { hasCookie: false };
  });

  // 业务接口
  handle('api:feeds', ({ offset = 0, limit = 20, pull = 0 }) => heybox.getFeeds(offset, limit, pull));
  handle('api:categories', () => heybox.getCategories());
  handle('api:topicFeeds', ({ topicId, offset = 0, limit = 20, sortType = 0 }) =>
    heybox.getTopicFeeds(topicId, offset, limit, sortType));
  handle('api:linkTree', ({ linkId, page = 1, limit = 20, index = 1, ownerOnly = 0 }) =>
    heybox.getLinkTree(linkId, { page, limit, index, ownerOnly }));
  handle('api:search', ({ q, type = 'link', offset = 0, limit = 20 }) =>
    heybox.search(q, { type, offset, limit }));
  handle('api:searchTopics', ({ q, offset = 0, limit = 20 }) => heybox.searchTopics(q, offset, limit));
  handle('api:messages', ({ listType = 0, offset = 0, limit = 20 } = {}) =>
    heybox.getMessages({ listType, offset, limit }));

  // 打开外部链接
  handle('shell:open', ({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
  ipcMain.handle('window:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));

  // 直接请求（给前端做自定义接口用，仍走签名）
  handle('api:raw', ({ path: p, params, webVersion }) => heybox.request(p, params || {}, { webVersion }));
}

/* ------------------------- 启动 ------------------------- */

app.whenReady().then(() => {
  const cfg = loadConfig();
  heybox.configure({
    cookie: cfg.cookie || '',
    deviceId: cfg.deviceId || undefined,
    heyboxId: cfg.heyboxId || '0',
  });
  if (!cfg.deviceId) saveConfig({ deviceId: heybox.getState().deviceId });

  registerImageProtocol();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
