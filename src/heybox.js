'use strict';
/**
 * 小黑盒 API 客户端
 * 负责：公共参数拼装、请求签名、Cookie 透传、错误归一化、风控冷却
 *
 * 契约核对日期：2026-11-23（匿名实测，详见 README「接口现状」）
 * 上游接口随时可能变更，所有解析逻辑都做了兜底，失败时降级而不是崩溃。
 */

const { signUrl, randomDeviceId } = require('./hkey');

const API_HOST = 'https://api.xiaoheihe.cn';

/** 公共参数（对齐官方 Web 端 3.0） */
const BASE_PARAMS = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '3.0',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 命中 show_captcha 后，只对**同类风控接口**暂停请求，避免延长风控时间。
 * 不能全局熔断：详情被风控时推荐流/扫码登录仍然完全正常，全局熔断会把可用功能一起锁死。
 */
const CAPTCHA_COOLDOWN_MS = 3 * 60 * 1000;

/** 风控分组：同一组共享冷却窗口 */
const RISK_GROUPS = [
  { name: 'link', test: (p) => p.startsWith('/bbs/app/link/') },
  { name: 'search', test: (p) => p.includes('/search/') },
  { name: 'user', test: (p) => p.startsWith('/bbs/app/user/') || p.startsWith('/account/restore_login') },
];

function riskGroupOf(pathname) {
  const g = RISK_GROUPS.find((x) => x.test(pathname));
  return g ? g.name : null;
}

/** 内存态配置，由主进程注入 */
const state = {
  deviceId: randomDeviceId(),
  cookie: '',
  heyboxId: '0',
  // 分组名 -> 命中时间
  challengedAt: Object.create(null),
};

function configure(patch = {}) {
  if (patch.deviceId) state.deviceId = patch.deviceId;
  if (typeof patch.cookie === 'string') state.cookie = patch.cookie;
  if (patch.heyboxId) state.heyboxId = String(patch.heyboxId);
}

function getState() {
  return {
    deviceId: state.deviceId,
    hasCookie: !!state.cookie,
    heyboxId: state.heyboxId,
    captchaCooldownMs: captchaCooldownRemainingMs(),
  };
}

/** 距离上次命中人机验证还剩多少冷却时间（0 表示没有冷却） */
function captchaCooldownRemainingMs(pathname) {
  const groups = pathname ? [riskGroupOf(pathname)].filter(Boolean) : Object.keys(state.challengedAt);
  let max = 0;
  for (const g of groups) {
    if (!state.challengedAt[g]) continue;
    max = Math.max(max, CAPTCHA_COOLDOWN_MS - (Date.now() - state.challengedAt[g]));
  }
  return max > 0 ? max : 0;
}

function noteCaptcha(pathname) {
  const g = riskGroupOf(pathname || '');
  if (!g) return;
  state.challengedAt[g] = Date.now();
}

function resetCaptcha() {
  state.challengedAt = Object.create(null);
}

/** 从 Cookie 串里解析 heybox_id */
function extractHeyboxId(cookie) {
  if (!cookie) return null;
  const m = /(?:^|;\s*)heybox_id=([^;]+)/.exec(cookie);
  return m ? m[1].trim() : null;
}

function buildUrl(pathname, params = {}, webVersion) {
  const u = new URL(API_HOST + pathname);
  const merged = {
    ...BASE_PARAMS,
    ...(webVersion ? { web_version: webVersion } : null),
    device_id: state.deviceId,
    heybox_id: state.heyboxId,
    ...params,
  };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return signUrl(u.toString());
}

/* ------------------------------------------------------------------ */
/* 文本归一化：搜索结果的标题/摘要里带 <em> 高亮标签                    */
/* ------------------------------------------------------------------ */

function htmlToText(value) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 帖子正文有两种形态：
 *  1) 纯 HTML 字符串
 *  2) 文本块数组的 JSON 序列化 `[{"type":"text","text":"..."}, {"type":"img","url":"..."}]`
 * 统一拍平成 { text, images }。
 */
function parseRichText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { text: '', images: [] };
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const parts = [];
        const images = [];
        for (const part of parsed) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'img' && part.url) images.push(part.url);
          if (part.text) {
            parts.push(htmlToText(part.text));
            for (const m of part.text.matchAll(/<img[^>]+(?:data-original|src)=["']([^"']+)["']/gi)) {
              images.push(m[1]);
            }
          } else if (part.type === 'html' && part.url) {
            images.push(part.url);
          }
        }
        return { text: parts.filter(Boolean).join('\n'), images: [...new Set(images)] };
      }
    } catch {
      /* 不是合法 JSON，按 HTML 处理 */
    }
  }
  const images = [...trimmed.matchAll(/<img[^>]+(?:data-original|src)=["']([^"']+)["']/gi)].map((m) => m[1]);
  return { text: htmlToText(trimmed), images: [...new Set(images)] };
}

/** 把 /bbs/app/link/tree 的 comments 分组结构拍平成普通评论数组 */
function normalizeComments(groups) {
  if (!Array.isArray(groups)) return [];
  const out = [];
  const pushOne = (c, depth) => {
    if (!c || typeof c !== 'object' || c.commentid === undefined) return;
    const children = Array.isArray(c.comments) ? c.comments : Array.isArray(c.sub_comments) ? c.sub_comments : [];
    const item = {
      commentid: c.commentid,
      userid: c.userid,
      user: c.user || {},
      text: htmlToText(c.text != null ? c.text : c.content),
      up: Number(c.up) || 0,
      create_at: Number(c.create_at) || 0,
      floor_num: Number(c.floor_num) || 0,
      child_num: Number(c.child_num) || 0,
      is_link_owner: Number(c.is_link_owner) || 0,
      is_top: Number(c.is_top) || 0,
      depth,
      sub_comments: children.map((x) => normalizeComments([x])[0]).filter(Boolean),
    };
    out.push(item);
  };
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) {
      // 直接的评论数组
      for (const c of group) pushOne(c, 0);
    } else if (Array.isArray(group.comment)) {
      // 官方结构：[{ comment: [ ... ] }]
      for (const c of group.comment) pushOne(c, 0);
    } else if (Array.isArray(group.comments)) {
      for (const c of group.comments) pushOne(c, 0);
    } else if (group.commentid !== undefined) {
      pushOne(group, 0);
    }
  }
  return out;
}

/**
 * 发起请求
 * @param {string} pathname
 * @param {object} params
 * @param {{timeout?:number, cookie?:string, webVersion?:string}} [opts]
 * @returns {Promise<{ok:boolean,status:string,msg:string,result:any,needLogin:boolean}>}
 */
async function request(pathname, params = {}, { timeout = 15000, cookie, webVersion } = {}) {
  // 命中过 show_captcha 时先冷却，不继续打接口（只冷却同类接口）
  const cooldown = captchaCooldownRemainingMs(pathname);
  if (cooldown > 0) {
    return {
      ok: false,
      status: 'captcha_cooldown',
      msg: `该接口刚触发人机验证，请求已暂停，请约 ${Math.ceil(cooldown / 1000)} 秒后再试`,
      result: null,
      needLogin: false,
      setCookie: [],
      retryAfter: Math.ceil(cooldown / 1000),
    };
  }

  const url = buildUrl(pathname, params, webVersion);
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.xiaoheihe.cn/',
    Origin: 'https://www.xiaoheihe.cn',
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
      return {
        ok: false,
        status: res.status === 404 ? 'not_found' : 'bad_json',
        msg:
          res.status === 404
            ? `接口不存在或已下线 (HTTP 404)`
            : `响应解析失败 (HTTP ${res.status})`,
        result: null,
        needLogin: false,
        setCookie,
        httpStatus: res.status,
      };
    }
    const status = json.status || 'unknown';
    if (status === 'show_captcha') noteCaptcha(pathname);
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

/**
 * 推荐信息流。
 * 注意：服务端**每页固定 10 条**，传 limit 不生效；分页靠 offset 累加实际条数。
 * pull=1 会「拉取新内容」，可能返回 11 条并伴随少量重复，客户端需按 linkid 去重。
 */
const getFeeds = (offset = 0, limit = 20, pull = 0) =>
  request('/bbs/app/feeds', { offset, pull, limit });

/** 板块分类（含热门社区、推荐板块、已订阅板块） */
const getCategories = () => request('/bbs/app/topic/categories', {});

/** 板块帖子列表（服务端每页约 20 条） */
const getTopicFeeds = (topicId, offset = 0, limit = 20, sortType = 0) =>
  request('/bbs/app/topic/feeds', { topic_id: topicId, offset, limit, sort_type: sortType });

/** 社区头条 */
const getTopicNews = (topicId, limit = 20) =>
  request('/bbs/app/topic/feeds/news', { topic_id: topicId, limit });

/** 首页 banner */
const getBanner = () => request('/bbs/app/feeds/banner', {});

/**
 * 帖子详情 + 评论树。
 * 官方 Web 端用 page / is_first / index / owner_only 分页；
 * 该接口有强风控，匿名基本恒返回 show_captcha，需要有效登录 Cookie。
 *
 * 返回前会把正文（link.text 是文本块数组的 JSON 串）和评论分组结构拍平成
 * 渲染层直接可用的形状，避免 UI 反复判断上游格式。
 */
async function getLinkTree(linkId, { page = 1, limit = 20, index = 1, ownerOnly = 0 } = {}) {
  const res = await request('/bbs/app/link/tree', {
    link_id: linkId,
    page,
    is_first: page === 1 ? 1 : 0,
    index,
    limit,
    owner_only: ownerOnly,
  });
  if (!res.ok) return res;

  const r = res.result || {};
  const link = r.link || {};
  // 服务端有时会返回 status=ok 但 result 为空（风控降级），这里补齐成明确的失败
  if (!link.linkid && !link.title && !Array.isArray(r.comments)) {
    return {
      ...res,
      ok: false,
      status: 'empty_result',
      msg: '详情接口返回空结果（可能被风控限流），请稍后重试或填入 Cookie',
      needLogin: true,
    };
  }

  const rich = parseRichText(link.text || link.description || '');
  const comments = normalizeComments(r.comments || []);
  // 正文图片：优先文本块里的，其次列表自带的
  const images = rich.images.length ? rich.images : Array.isArray(link.imgs) ? link.imgs : [];
  return {
    ...res,
    result: {
      ...r,
      link: { ...link, text: rich.text, images },
      comments,
      hasMoreFloors: Number(r.has_more_floors) === 1,
      totalFloorNum: Number(r.total_floor_num) || comments.length,
    },
  };
}

/**
 * 站内搜索（注意：不是 /search/v1/web，那个已废弃并强制要求登录）。
 * search_type: link（帖子）/ user（用户）/ topic（话题）
 * 返回的 items 是混合类型，需按 type 过滤，帖子内容在 item.info 里。
 */
async function search(q, { type = 'link', offset = 0, limit = 20 } = {}) {
  const res = await request(
    '/bbs/app/api/general/search/v1',
    { q, search_type: type, is_pull_down: 0, offset, limit, dw: 628 },
    { webVersion: '3.0' }
  );
  if (!res.ok) return res;
  const items = (res.result && res.result.items) || [];
  const list = items
    .filter((it) => it && it.type === (type === 'link' ? 'link' : type))
    .map((it) => it.info || {})
    .filter(Boolean)
    .map((info) => ({
      ...info,
      title: htmlToText(info.title),
      description: htmlToText(info.description),
    }));
  return { ...res, result: { ...(res.result || {}), links: list, items } };
}

/** 话题（社区/游戏）搜索，匿名可用 */
const searchTopics = (q, offset = 0, limit = 20) =>
  request('/bbs/app/api/search/topic', { q, offset, limit });

/** 我的消息（未登录时接口仍返回 status=ok，但 messages 为空，需自行判定） */
async function getMessages({ listType = 0, offset = 0, limit = 20 } = {}) {
  const res = await request('/bbs/app/user/message', {
    list_type: listType,
    offset,
    limit,
    no_more: 'false',
  });
  if (!res.ok) return res;
  const r = res.result || {};
  const messages = r.messages || [];
  const unread = Number(r.message_unread_num) || 0;
  // 匿名单下服务端不会报错，只会给一个空的 messages + header 骨架
  const anonymous = messages.length === 0 && unread === 0 && !state.cookie;
  return {
    ...res,
    needLogin: anonymous,
    anonymous,
    result: { ...r, messages, anonymous },
  };
}

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
  const qrUrl = String((res.result && res.result.qr_url) || '').trim();
  if (!qrUrl) return { ok: false, message: '二维码响应缺少 qr_url' };
  let token = '';
  try {
    token = new URL(qrUrl).searchParams.get('qr') || '';
  } catch {
    /* ignore */
  }
  if (!token) return { ok: false, message: '二维码响应缺少 qr 参数' };
  return { ok: true, url: qrUrl, token, expiresIn: Number(res.result && res.result.expire) || 120 };
}

/** 组装登录 Cookie（对齐官方 e6e()：heybox_id/user_heybox_id/pkey/user_pkey + 会话 Cookie） */
function buildLoginCookie({ heyboxId, pkey, xXhh, setCookie = [] } = {}) {
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
  // 2) 官方页面从响应体写入的核心 Cookie（优先级最高，覆盖同名）
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
  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  const levelInfo = ad.level_info || pd.level_info || {};
  return {
    heyboxId: str(pd.heybox_id) || str(ad.userid) || str(r.heybox_id) || '',
    nickname: str(pd.nickname) || str(ad.username) || '',
    avatar: str(pd.avatar) || str(ad.avatar) || str(ad.avartar) || '',
    level: levelInfo.level === undefined ? null : levelInfo.level,
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

    // pkey 不保证出现在 result 顶层：上游会把它放在 Set-Cookie / 会话 Cookie 罐里，
    // 有些账号（如走新版风控的）干脆只下发 heybox_id + 资料。
    // 因此先按 result -> Cookie 罐 -> Set-Cookie 的顺序找，找不到也不阻断登录。
    const fromJar = (name) => {
      const hit = qrCookieJar.find((c) => c.startsWith(name + '='));
      return hit ? hit.slice(name.length + 1) : '';
    };
    const pkey =
      String(r.pkey || r.user_pkey || '').trim() ||
      fromJar('pkey') ||
      fromJar('user_pkey');

    // 只要拿到 heybox_id 就算登录成功（账号身份已经确认）；
    // 缺失 pkey 时记录提示，交给后续 restore_login 判定真实可用性。
    if (!prof.heyboxId) {
      return {
        state: 'error',
        message: '登录响应缺少用户标识，请重试或改用 Cookie 登录',
        detail: `result=${JSON.stringify(r).slice(0, 400)}`,
      };
    }

    const cookie = buildLoginCookie({
      heyboxId: prof.heyboxId,
      pkey,
      xXhh: String(r.x_xhh_heyboxid || '').trim(),
      setCookie: res.setCookie,
    });

    return {
      state: 'succeeded',
      heyboxId: prof.heyboxId,
      pkey,
      profile: prof,
      cookie,
      // pkey 缺失时下游用 restore_login 兜底校验，这里只做提示不阻断
      warning: pkey ? '' : 'pkey 未随扫码响应下发，已用会话 Cookie 兜底；若功能受限请改用 Cookie 登录',
    };
  }

  return {
    state: 'expired',
    message: String(r.error_msg || res.msg || '').trim() || '二维码已失效',
  };
}

/** 获取当前登录用户资料（对齐官方：/account/restore_login） */
async function getProfile() {
  const res = await request('/account/restore_login', {});
  if (!res.ok) {
    return {
      ok: false,
      needLogin: res.needLogin || res.status === 'login',
      message: res.msg || (res.status === 'login' ? '登录态已失效或未登录' : res.status),
    };
  }
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
  getTopicNews,
  getBanner,
  getLinkTree,
  search,
  searchTopics,
  getMessages,
  createQrLogin,
  pollQrLogin,
  getProfile,
  buildLoginCookie,
  extractProfile,
  normalizeComments,
  parseRichText,
  htmlToText,
  noteCaptcha,
  resetCaptcha,
  captchaCooldownRemainingMs,
  API_HOST,
  UA,
};
