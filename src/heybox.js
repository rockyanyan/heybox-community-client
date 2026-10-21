'use strict';
/**
 * 小黑盒 API 客户端
 * 负责：公共参数拼装、请求签名、Cookie 透传、错误归一化
 */

const { signUrl, randomDeviceId } = require('./hkey');

const API_HOST = 'https://api.xiaoheihe.cn';

/** 公共参数（对齐 web 端） */
const BASE_PARAMS = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '2.5',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 内存态配置，由主进程注入 */
const state = {
  deviceId: randomDeviceId(),
  cookie: '',
  heyboxId: '0',
};

function configure(patch = {}) {
  if (patch.deviceId) state.deviceId = patch.deviceId;
  if (typeof patch.cookie === 'string') state.cookie = patch.cookie;
  if (patch.heyboxId) state.heyboxId = String(patch.heyboxId);
}

function getState() {
  return { deviceId: state.deviceId, hasCookie: !!state.cookie, heyboxId: state.heyboxId };
}

/** 从 Cookie 串里解析 heybox_id */
function extractHeyboxId(cookie) {
  if (!cookie) return null;
  const m = /(?:^|;\s*)heybox_id=([^;]+)/.exec(cookie);
  return m ? m[1].trim() : null;
}

function buildUrl(pathname, params = {}) {
  const u = new URL(API_HOST + pathname);
  const merged = {
    ...BASE_PARAMS,
    device_id: state.deviceId,
    heybox_id: state.heyboxId,
    ...params,
  };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return signUrl(u.toString());
}

/**
 * 发起请求
 * @returns {Promise<{ok:boolean,status:string,msg:string,result:any,needLogin:boolean}>}
 */
async function request(pathname, params = {}, { timeout = 15000, cookie } = {}) {
  const url = buildUrl(pathname, params);
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://xiaoheihe.cn/',
    Origin: 'https://xiaoheihe.cn',
  };
  const effectiveCookie = cookie !== undefined ? cookie : state.cookie;
  if (effectiveCookie) headers.Cookie = effectiveCookie;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: 'bad_json', msg: `响应解析失败 (HTTP ${res.status})`, result: null, needLogin: false, setCookie };
    }
    const status = json.status || 'unknown';
    return {
      ok: status === 'ok',
      status,
      msg: json.msg || '',
      result: json.result || null,
      needLogin: status === 'login' || status === 'show_captcha',
      httpStatus: res.status,
      setCookie,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 'timeout' : 'network_error',
      msg: aborted ? '请求超时' : `网络错误：${err.message}`,
      result: null,
      needLogin: false,
      setCookie: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 业务接口 ============================ */

/** 推荐信息流 */
const getFeeds = (offset = 0, limit = 20, pull = 1) =>
  request('/bbs/app/feeds', { offset, limit, pull });

/** 板块分类（含热门社区、推荐板块） */
const getCategories = () => request('/bbs/app/topic/categories', {});

/** 板块帖子列表 */
const getTopicFeeds = (topicId, offset = 0, limit = 20, sortType = 0) =>
  request('/bbs/app/topic/feeds', { topic_id: topicId, offset, limit, sort_type: sortType });

/** 帖子详情 + 评论树 */
const getLinkTree = (linkId, offset = 0, limit = 20) =>
  request('/bbs/app/link/tree', { link_id: linkId, offset, limit, hb_rich_texts: 1 });

/** 搜索 */
const search = (q, offset = 0, limit = 20) =>
  request('/bbs/app/api/general/search/v1/web', { q, offset, limit });

/** 全部社区/话题分页 */
const getTopicList = (offset = 0, limit = 30) =>
  request('/bbs/app/topic/feeds/all', { offset, limit });

/** 我的消息 */
const getMessages = () => request('/bbs/app/user/message', {});

/* ======================= 二维码扫码登录 ======================= */

/**
 * 流程（已用 CDP 抓包核对官方 Web 端，完全一致）：
 *   1. GET /account/get_qrcode_url/?app=web -> { qr_url, expire }
 *      qr_url 形如 https://api.xiaoheihe.cn/account/qr_login/?qr=<uuid>&app=web
 *   2. GET /account/qr_state/?qr=<uuid>&app=web
 *      -> result.error: wait(待扫) / ready(已扫待确认) / ok(成功) / 其他(失效)
 *   3. 成功后官方做法是把 result 里的 heybox_id / pkey 写成 Cookie，
 *      这里等价地拼出 Cookie 串（同时合并整个会话期间服务端下发的 Set-Cookie）。
 */

// 整个扫码会话的 Cookie 罐：create 起累计，轮询响应里下发的 Cookie 也会并进来
let qrCookieJar = [];

function jarMerge(setCookie = []) {
  for (const raw of setCookie) {
    const kv = String(raw).split(';')[0].trim();
    const k = kv.split('=')[0];
    if (!k) continue;
    qrCookieJar = qrCookieJar.filter((c) => !c.startsWith(k + '='));
    qrCookieJar.push(kv);
  }
}

/** 把 Cookie 罐序列化成请求头 */
const jarToHeader = () => qrCookieJar.join('; ');

/** 创建二维码 */
async function createQrLogin() {
  qrCookieJar = [];
  const res = await request('/account/get_qrcode_url/', { app: 'web' }, { cookie: jarToHeader() });
  jarMerge(res.setCookie);
  if (!res.ok) return { ok: false, message: res.msg || `创建二维码失败（${res.status}）` };
  const qrUrl = String(res.result?.qr_url || '').trim();
  if (!qrUrl) return { ok: false, message: '二维码响应缺少 qr_url' };
  let token = '';
  try {
    token = new URL(qrUrl).searchParams.get('qr') || '';
  } catch {
    /* ignore */
  }
  if (!token) return { ok: false, message: '二维码响应缺少 qr 参数' };
  return { ok: true, url: qrUrl, token, expiresIn: Number(res.result?.expire) || 120 };
}

/** 组装登录 Cookie（对齐官方 e6e()：heybox_id/user_heybox_id/pkey/user_pkey + 会话 Cookie） */
function buildLoginCookie({ heyboxId, pkey, xXhh, setCookie = [] }) {
  const parts = [];
  const seen = new Set();
  const add = (k, v) => {
    if (!v) return;
    const kv = `${k}=${v}`;
    if (seen.has(k)) {
      const i = parts.findIndex((p) => p.startsWith(k + '='));
      if (i >= 0) parts[i] = kv;
      return;
    }
    seen.add(k);
    parts.push(kv);
  };
  // 1) 会话期间服务端下发的 Cookie（含登录成功响应的 Set-Cookie）
  for (const raw of [...setCookie, ...qrCookieJar]) {
    const kv = String(raw).split(';')[0].trim();
    const k = kv.split('=')[0];
    if (k && kv.includes('=') && !seen.has(k)) {
      seen.add(k);
      parts.push(kv);
    }
  }
  // 2) 官方页面从响应体写入的四个核心 Cookie（优先级最高，覆盖同名）
  add('heybox_id', heyboxId);
  add('user_heybox_id', heyboxId);
  add('x_xhh_heyboxid', xXhh || heyboxId);
  add('pkey', pkey);
  add('user_pkey', pkey);
  return parts.join('; ');
}

/** 从成功响应里提取用户资料（对齐官方 gj()） */
function extractProfile(r = {}) {
  const pd = r.profile || {};
  const ad = r.account_detail || {};
  const str = (v) => String(v ?? '').trim();
  return {
    heyboxId: str(pd.heybox_id) || str(ad.userid) || str(r.heybox_id) || '',
    nickname: str(pd.nickname) || str(ad.username) || '',
    avatar: str(pd.avatar) || str(ad.avatar) || str(ad.avartar) || '',
    level: ad.level_info?.level ?? null,
  };
}

/** 轮询扫码状态 */
async function pollQrLogin(token) {
  // 与官方一致：轮询时带上整个会话累积的 Cookie（不掺入全局登录态）
  const res = await request('/account/qr_state/', { app: 'web', qr: token }, { cookie: jarToHeader() });
  jarMerge(res.setCookie);

  // 网络层/临时错误：不算失败，让 UI 继续轮询
  if (res.status === 'timeout' || res.status === 'network_error' || res.status === 'bad_json') {
    return { state: 'retry', message: res.msg || '网络波动，重试中' };
  }

  if (!res.ok) {
    if (res.status === 'need_google_check') {
      return { state: 'need_google', message: '该账号需要谷歌二次验证，请改用 Cookie 手动登录' };
    }
    return {
      state: 'error',
      message: res.msg || `状态查询失败（${res.status}）`,
      detail: `status=${res.status} result=${JSON.stringify(res.result)}`,
    };
  }

  const r = res.result || {};
  const flag = String(r.error || '').trim();

  if (flag === 'wait') return { state: 'waiting' };
  if (flag === 'ready') return { state: 'scanned' };

  if (flag === 'ok') {
    const prof = extractProfile(r);
    const pkey = String(r.pkey || r.user_pkey || '').trim();
    if (!prof.heyboxId || !pkey) {
      return {
        state: 'error',
        message: '登录响应缺少登录态字段，请重试或改用 Cookie 登录',
        detail: `heybox_id="${prof.heyboxId}" pkey="${pkey ? '(有)' : '(无)'}" result=${JSON.stringify(r).slice(0, 300)}`,
      };
    }
    return {
      state: 'succeeded',
      heyboxId: prof.heyboxId,
      pkey,
      profile: prof,
      cookie: buildLoginCookie({
        heyboxId: prof.heyboxId,
        pkey,
        xXhh: String(r.x_xhh_heyboxid || '').trim(),
        setCookie: res.setCookie,
      }),
    };
  }

  return {
    state: 'expired',
    message: String(r.error_msg || res.msg || '').trim() || '二维码已失效',
  };
}

/** 获取当前登录用户资料（对齐官方：优先 /account/restore_login） */
async function getProfile() {
  let res = await request('/account/restore_login', {});
  if (!res.ok && res.status !== 'login') {
    // 某些场景下 restore_login 不可用时退回旧接口
    const alt = await request('/bbs/app/profile/user/profile', {
      userid: state.heyboxId && state.heyboxId !== '0' ? state.heyboxId : '',
    });
    if (alt.ok) {
      const p = alt.result || {};
      return {
        ok: true,
        profile: {
          heyboxId: String(p.userid || p.heybox_id || ''),
          nickname: p.username || p.nickname || '',
          avatar: p.avatar || p.avartar || '',
          level: p.level_info?.level ?? null,
        },
      };
    }
  }
  if (!res.ok) return { ok: false, message: res.msg || res.status };
  const r = res.result || {};
  const prof = extractProfile(r);
  if (!prof.heyboxId) return { ok: false, message: '登录态已失效' };
  if (!state.heyboxId || state.heyboxId === '0') state.heyboxId = prof.heyboxId;
  // 补全 pkey（restore_login 的 result 里同样带）
  const pkey = String(r.pkey || r.user_pkey || '').trim();
  if (pkey && state.cookie && !/(^|;\s*)pkey=/.test(state.cookie)) {
    state.cookie += `; pkey=${pkey}; user_pkey=${pkey}`;
  }
  return { ok: true, profile: prof };
}

module.exports = {
  configure,
  getState,
  extractHeyboxId,
  request,
  getFeeds,
  getCategories,
  getTopicFeeds,
  getLinkTree,
  search,
  getTopicList,
  getMessages,
  createQrLogin,
  pollQrLogin,
  getProfile,
  buildLoginCookie,
  API_HOST,
  UA,
};
