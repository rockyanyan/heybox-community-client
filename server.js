'use strict';
/**
 * 浏览器开发模式服务（不依赖 Electron）
 * - 静态托管 renderer/
 * - /rpc      转发小黑盒 API（复用 src/heybox.js，签名在服务端完成）
 * - /img      图片防盗链代理
 * - /config   Cookie 配置
 * 用途：在浏览器里预览/调试界面，逻辑与 Electron 版完全一致。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const QRCode = require('qrcode');
const heybox = require('./src/heybox');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, '.dev-config.json');

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; }
}
function saveCfg(patch) {
  const next = { ...loadCfg(), ...patch };
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2));
  return next;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const IMG_HOSTS = ['.xiaoheihe.cn', '.max-c.com'];
function isAllowedImage(u) {
  try {
    const p = new URL(u);
    return IMG_HOSTS.some((h) => p.hostname === h.slice(1) || p.hostname.endsWith(h));
  } catch { return false; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  /* ---- RPC ---- */
  if (parsed.pathname === '/rpc' && req.method === 'POST') {
    const { fn, args = [] } = await readBody(req);
    const table = {
      feeds: () => heybox.getFeeds(args[0], args[1], args[2]),
      categories: () => heybox.getCategories(),
      topicFeeds: () => heybox.getTopicFeeds(args[0], args[1], args[2], args[3]),
      linkTree: () => heybox.getLinkTree(args[0], args[1], args[2]),
      search: () => heybox.search(args[0], args[1], args[2]),
    };
    if (!table[fn]) return json(res, 404, { ok: false, error: 'unknown fn: ' + fn });
    try { return json(res, 200, { ok: true, data: await table[fn]() }); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  /* ---- 图片代理 ---- */
  if (parsed.pathname === '/img') {
    const target = parsed.query.u;
    if (!target || !isAllowedImage(target)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const r = await fetch(target, { headers: { Referer: 'https://xiaoheihe.cn/', 'User-Agent': heybox.UA } });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=3600' });
      return res.end(buf);
    } catch { res.writeHead(502); return res.end('proxy error'); }
  }

  /* ---- 配置 ---- */
  if (parsed.pathname === '/config' && req.method === 'GET') {
    const c = loadCfg();
    return json(res, 200, {
      ok: true,
      data: {
        hasCookie: !!(c.cookie && c.cookie.trim()),
        deviceId: heybox.getState().deviceId,
        profile: c.profile || null,
      },
    });
  }
  if (parsed.pathname === '/config/cookie' && req.method === 'POST') {
    const { cookie = '' } = await readBody(req);
    const c = (cookie || '').trim();
    const hbId = heybox.extractHeyboxId(c);
    saveCfg({ cookie: c, heyboxId: hbId || '0', profile: c ? loadCfg().profile || null : null });
    heybox.configure({ cookie: c, heyboxId: hbId || '0' });
    return json(res, 200, { ok: true, data: { hasCookie: !!c, heyboxId: hbId || '0' } });
  }

  /* ---- 扫码登录 ---- */
  if (parsed.pathname === '/auth/qr/create' && req.method === 'GET') {
    try {
      const r = await heybox.createQrLogin();
      if (!r.ok) return json(res, 200, { ok: true, data: r });
      const qrDataUrl = await QRCode.toDataURL(r.url, {
        width: 320, margin: 4, errorCorrectionLevel: 'M',
        color: { dark: '#14151aff', light: '#ffffffff' },
      });
      return json(res, 200, { ok: true, data: { ok: true, token: r.token, expiresIn: r.expiresIn, qrDataUrl, url: r.url } });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (parsed.pathname === '/auth/qr/poll' && req.method === 'POST') {
    const { token } = await readBody(req);
    if (!token) return json(res, 200, { ok: false, error: 'missing token' });
    try {
      const r = await heybox.pollQrLogin(token);
      if (r.state === 'succeeded') {
        saveCfg({ cookie: r.cookie, heyboxId: r.heyboxId, profile: r.profile || null });
        heybox.configure({ cookie: r.cookie, heyboxId: r.heyboxId });
        let profile = r.profile || null;
        let warn = '';
        try {
          const p = await heybox.getProfile();
          if (p.ok) { profile = p.profile; saveCfg({ profile }); }
          else warn = `登录态已保存，但校验未通过（${p.message || '未知原因'}），部分功能可能不可用`;
        } catch (e) { warn = `登录态已保存，但资料拉取失败：${e.message}`; }
        return json(res, 200, { ok: true, data: { state: 'succeeded', heyboxId: r.heyboxId, profile, warn } });
      }
      return json(res, 200, { ok: true, data: r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (parsed.pathname === '/auth/profile' && req.method === 'GET') {
    try {
      const p = await heybox.getProfile();
      if (p.ok) saveCfg({ profile: p.profile });
      return json(res, 200, { ok: true, data: p });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (parsed.pathname === '/auth/logout' && req.method === 'POST') {
    saveCfg({ cookie: '', profile: null, heyboxId: '0' });
    heybox.configure({ cookie: '', heyboxId: '0' });
    return json(res, 200, { ok: true, data: { hasCookie: false } });
  }

  /* ---- 应用信息 ---- */
  if (parsed.pathname === '/appinfo') {
    return json(res, 200, { ok: true, data: { version: '1.0.0', electron: 'browser-dev' } });
  }

  /* ---- 静态文件 ---- */
  let file = parsed.pathname === '/' ? '/renderer/index.html' : parsed.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  let full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  // 兼容 /style.css 这类相对引用：回退到 renderer/ 目录
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    const alt = path.join(ROOT, 'renderer', file);
    if (fs.existsSync(alt) && fs.statSync(alt).isFile()) full = alt;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  let body = fs.readFileSync(full);
  // 浏览器模式需要放开 connect-src 以便 fetch /rpc（Electron 版保持严格 CSP）
  if (full.endsWith('.html')) {
    body = Buffer.from(body.toString('utf8').replace("connect-src 'none'", "connect-src 'self'"), 'utf8');
  }
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = loadCfg();
  heybox.configure({ cookie: cfg.cookie || '', deviceId: cfg.deviceId, heyboxId: cfg.heyboxId || '0' });
  console.log(`[dev] http://127.0.0.1:${PORT}`);
});
