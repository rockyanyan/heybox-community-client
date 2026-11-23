'use strict';
/**
 * 渲染进程逻辑：视图路由、数据加载、DOM 渲染
 *
 * 分页要点（实测）：
 *  - /bbs/app/feeds 每页固定 10 条，limit 参数无效 -> offset 必须按「实际返回条数」推进
 *  - /bbs/app/topic/feeds 每页约 20 条
 *  - pull=1 的推荐流会出现重复条目 -> 按 linkid 去重
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  view: 'feed',
  topics: [],          // 热门社区列表
  currentTopic: null,  // 当前板块
  sortType: 0,
  feed: { offset: 0, loading: false, done: false, items: [], seen: new Set() },
  searching: false,
  hasCookie: false,
  profile: null,
  captchaCooldownMs: 0,
};

/* ==================== 工具函数 ==================== */

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 数字格式化：12345 -> 1.2万 */
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

/** 相对时间 */
function fmtTime(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
  const d = new Date(Number(ts) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

const IMG_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2b2f38"/></svg>'
  );

const img = (u) => (u ? window.heybox.img(u) : IMG_PLACEHOLDER);

/** 分享链接里的 link_id 有时是 base64 串，统一还原成数字 id */
function postUrl(link) {
  if (link && link.share_url) return link.share_url;
  return link && link.linkid ? `https://www.xiaoheihe.cn/app/bbs/link/${link.linkid}` : '';
}

/* ==================== 图标 ==================== */
const ICON = {
  comment: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  award: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.9 6.7 19.6l1.1-6L3.4 9.4l6-.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M7 4l12 8-12 8z" fill="currentColor"/></svg>',
};

/* ==================== 帖子卡片 ==================== */

function postCardHTML(link) {
  const user = link.user || {};
  const imgs = (link.imgs || []).filter(Boolean);
  const topics = (link.topics || []).slice(0, 4);
  const lv = user.level_info && user.level_info.level;

  const single = imgs.length === 1;
  const media = single
    ? `<img class="post-thumb-single" src="${esc(img(imgs[0]))}" loading="lazy" onerror="this.src='${IMG_PLACEHOLDER}'" />`
    : '';

  const thumbs =
    !single && imgs.length > 1
      ? `<div class="post-thumbs">${imgs.slice(0, 3)
          .map((u) => `<img src="${esc(img(u))}" loading="lazy" onerror="this.src='${IMG_PLACEHOLDER}'" />`)
          .join('')}</div>`
      : '';

  return `
  <article class="post-card" data-link="${esc(link.linkid)}">
    <div class="post-main">
      <div class="post-author">
        ${user.avatar || user.avartar ? `<img src="${esc(img(user.avatar || user.avartar))}" onerror="this.style.visibility='hidden'" />` : ''}
        <span>${esc(user.username || '匿名用户')}</span>
        ${lv ? `<span class="lv">Lv.${esc(lv)}</span>` : ''}
      </div>
      <div class="post-title">${esc(link.title || '(无标题)')}</div>
      ${link.description ? `<div class="post-desc">${esc(link.description)}</div>` : ''}
      ${thumbs}
      ${
        topics.length
          ? `<div class="post-topics">${topics
              .map((t) => `<span class="tag-chip">#${esc(t.name)}</span>`)
              .join('')}</div>`
          : ''
      }
      <div class="post-meta">
        <span class="meta-item award">${ICON.award}${fmtNum(link.link_award_num)}</span>
        <span class="meta-item">${ICON.comment}${fmtNum(link.comment_num)}</span>
        ${link.has_video ? `<span class="meta-item">${ICON.play}视频</span>` : ''}
        <span class="meta-item" style="margin-left:auto">${fmtTime(link.create_at)}</span>
      </div>
    </div>
    ${media}
  </article>`;
}

function stateBox(emoji, title, desc, actionHTML = '') {
  return `<div class="state-box"><div style="font-size:30px">${emoji}</div><h4>${esc(title)}</h4><p>${desc}</p>${actionHTML}</div>`;
}

/** 需要登录 / 被风控时的统一提示 */
function loginBox(payload, fallbackTitle) {
  const captcha = payload && payload.status === 'show_captcha';
  const cooldown = payload && payload.status === 'captcha_cooldown';
  const title = captcha || cooldown ? '触发了人机验证' : fallbackTitle || '需要登录';
  const desc = cooldown
    ? esc((payload && payload.msg) || '站点要求人机验证，请求已暂停一段时间。')
    : captcha
      ? '小黑盒对该接口的风控很严，匿名请求会返回 show_captcha。请先在浏览器登录 xiaoheihe.cn 并完成一次人机验证，再把 Cookie 粘贴到设置里。'
      : '该接口要求登录态，请在设置中填入小黑盒 Cookie 后重试。';
  return stateBox(
    captcha || cooldown ? '🛡️' : '🔐',
    title,
    desc,
    '<button class="btn-primary" onclick="openSettings()">填入 Cookie</button>'
  );
}

/* ==================== 视图：推荐流 / 板块 ==================== */

async function loadFeed({ reset = false, topic = null } = {}) {
  const f = state.feed;
  if (f.loading) return;
  if (reset) {
    f.offset = 0;
    f.done = false;
    f.items = [];
    f.seen = new Set();
    f.pages = 0;
    $('#content').innerHTML =
      `<div class="content-head"><div class="content-title">${
        topic ? `<span>#${esc(topic.name)}</span><span class="sub">板块</span>` : '推荐'
      }</div></div><div id="feed-list" class="post-list">${'<div class="skeleton-card"></div>'.repeat(5)}</div>`;
  }
  if (f.done) return;

  f.loading = true;
  const limit = 20;

  let res;
  try {
    res = topic
      ? await window.heybox.api.topicFeeds(topic.topic_id, f.offset, limit, state.sortType || 0)
      : await window.heybox.api.feeds(f.offset, limit, 0);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  f.loading = false;

  const listEl = $('#feed-list');
  if (!listEl) return;

  if (f.offset === 0) listEl.innerHTML = '';

  const payload = res && res.ok ? res.data : null;

  if (!payload || !payload.ok) {
    if (f.offset === 0) {
      if (payload && (payload.needLogin || payload.status === 'captcha_cooldown')) {
        listEl.innerHTML = loginBox(payload, '内容加载失败');
      } else {
        listEl.innerHTML = stateBox(
          '😕',
          '内容加载失败',
          payload
            ? `接口返回：${esc(payload.msg || payload.status)}。可以尝试点击右上角刷新，或稍后重试。`
            : `无法连接到小黑盒服务器，请检查网络后重试。${res && res.error ? '（' + esc(res.error) + '）' : ''}`
        );
      }
    }
    f.done = true;
    return;
  }

  // 服务端每页条数是固定的（推荐流固定 10，板块约 20），limit 参数不生效，
  // 所以 offset 必须按「实际返回条数」推进；pull=1 时可能出现重复条目，按 linkid 去重。
  const raw = (payload.result && payload.result.links) || [];
  const fresh = raw.filter((l) => l && l.linkid != null && !f.seen.has(String(l.linkid)));
  for (const l of fresh) f.seen.add(String(l.linkid));

  f.offset += raw.length;

  if (!raw.length) {
    if (!f.items.length) listEl.innerHTML = stateBox('📭', '暂无内容', '这个板块暂时没有帖子。');
    f.done = true;
    return;
  }

  if (!fresh.length) {
    // 整页都是重复内容：直接往后翻一页，不要给用户看空列表（最多连翻 5 页防死循环）
    f.pages = (f.pages || 0) + 1;
    if (f.pages > 5) {
      f.done = true;
      return;
    }
    return loadFeed({ topic });
  }
  f.pages = 0;

  f.items.push(...fresh);

  // 推荐流是「无限」的，给一个上限，避免一直滚下去耗尽内存
  if (f.items.length >= 200) f.done = true;

  listEl.insertAdjacentHTML('beforeend', fresh.map(postCardHTML).join(''));

  // 触底加载
  if (!f.done) {
    const old = $('#feed-sentinel');
    if (old) old.remove();
    const sentinel = document.createElement('div');
    sentinel.className = 'load-more';
    sentinel.id = 'feed-sentinel';
    sentinel.innerHTML = '<div class="spinner"></div>';
    listEl.appendChild(sentinel);
    observeSentinel();
  } else {
    const old = $('#feed-sentinel');
    if (old) old.remove();
  }
}

let sentinelObserver = null;
function observeSentinel() {
  if (sentinelObserver) sentinelObserver.disconnect();
  const el = $('#feed-sentinel');
  if (!el) return;
  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        sentinelObserver.disconnect();
        el.remove();
        loadFeed({ topic: state.currentTopic });
      }
    },
    { root: $('#content'), rootMargin: '320px' }
  );
  sentinelObserver.observe(el);
}

/* ==================== 视图：全部社区 ==================== */

function renderTopicsView() {
  state.view = 'topics';
  setActiveNav('topics');
  $('#content').innerHTML = `
    <div class="content-head">
      <div class="content-title">全部社区 <span class="sub">共 ${state.topics.length} 个热门板块</span></div>
    </div>
    <div class="post-list" id="topics-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px"></div>`;
  const grid = $('#topics-grid');
  grid.innerHTML = state.topics
    .map(
      (t) => `
    <div class="post-card" data-topic='${esc(JSON.stringify({ topic_id: t.topic_id, name: t.name }))}' style="align-items:center">
      <img src="${esc(img(t.pic_url || t.small_pic_url))}" style="width:38px;height:38px;border-radius:9px;object-fit:cover;background:var(--surface-3)" onerror="this.style.visibility='hidden'"/>
      <div style="flex:1;min-width:0">
        <div class="post-title" style="font-size:13.5px;-webkit-line-clamp:1">${esc(t.name)}</div>
        <div class="post-desc" style="font-size:11.5px">热度 ${fmtNum(Math.round((t.hot && t.hot.raw_hot_value) || t.hot_value_v2 || 0))}</div>
      </div>
    </div>`
    )
    .join('');
}

/* ==================== 视图：搜索 ==================== */

async function doSearch(q) {
  const keyword = String(q || '').trim();
  if (!keyword) return;
  state.view = 'search';
  state.currentTopic = null;
  setActiveNav(null);
  $('#content').innerHTML = `
    <div class="content-head"><div class="content-title">搜索 <span class="sub">“${esc(keyword)}”</span></div></div>
    <div id="feed-list" class="post-list"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>`;

  const res = await window.heybox.api.search(keyword, 'link', 0, 20);
  const listEl = $('#feed-list');
  if (!listEl) return;
  const payload = res && res.ok ? res.data : null;

  if (!payload || !payload.ok) {
    if (payload && (payload.needLogin || payload.status === 'captcha_cooldown')) {
      listEl.innerHTML = loginBox(payload, '搜索需要登录');
    } else {
      listEl.innerHTML = stateBox('😕', '搜索失败', esc((payload && payload.msg) || '请稍后重试。'));
    }
    return;
  }

  const links = (payload.result && (payload.result.links || payload.result.list || payload.result.items)) || [];
  if (!links.length) {
    listEl.innerHTML = stateBox('🔍', '没有找到相关内容', '换个关键词试试吧。');
    return;
  }
  // 搜索结果不进入 feed 缓存，但详情页打开时需要能取到标题，这里单独存一份
  state.searchResults = links.filter((x) => x && x.linkid != null);
  listEl.innerHTML = links.map((l) => (l.type ? postCardHTML(l.info || {}) : postCardHTML(l))).join('');
}

/* ==================== 视图：帖子详情 ==================== */

async function openDetail(linkId) {
  const pools = [state.feed.items, state.searchResults || []];
  let link = null;
  for (const pool of pools) {
    link = pool.find((x) => String(x.linkid) === String(linkId));
    if (link) break;
  }
  state.view = 'detail';
  setActiveNav(null);
  state.currentLink = link || null;

  const c = $('#content');
  c.innerHTML = `
    <button class="detail-back">← 返回</button>
    <div class="detail-wrap">
      ${link ? `<h1 class="detail-title">${esc(link.title)}</h1>` : '<div class="skeleton-line" style="height:26px;width:60%"></div>'}
      ${link ? detailAuthorHTML(link) : ''}
      <div class="detail-body" id="detail-body">${
        link && link.description ? esc(link.description) : '<div class="spinner" style="margin:26px auto"></div>'
      }</div>
      ${
        link && (link.imgs || []).length
          ? `<div style="margin-top:14px" id="detail-imgs">${link.imgs
              .map((u) => `<img src="${esc(img(u))}" style="max-width:100%;border-radius:9px;margin:6px 0;display:block" onerror="this.style.display='none'"/>`)
              .join('')}</div>`
          : ''
      }
      <div id="detail-comments"></div>
    </div>`;
  $('.detail-back').onclick = () => goBack();
  c.scrollTop = 0;

  // 拉取详情/评论
  const res = await window.heybox.api.linkTree(linkId, 1, 20, 1, 0);
  const payload = res && res.ok ? res.data : null;
  const box = $('#detail-comments');
  if (!box) return;

  if (!payload || !payload.ok) {
    box.innerHTML = `
      <div class="comment-sec">
        <div class="detail-lock">
          <div class="lock-ico"><svg viewBox="0 0 24 24" width="34" height="34"><rect x="4" y="10" width="16" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></div>
          <h4>${payload && (payload.needLogin || payload.status === 'show_captcha') ? '查看完整内容与评论需要登录' : '详情加载失败'}</h4>
          <p style="max-width:420px;line-height:1.7">${
            payload && payload.status === 'captcha_cooldown'
              ? esc(payload.msg || '站点风控冷却中，请稍后再试。')
              : payload && (payload.needLogin || payload.status === 'show_captcha')
                ? '小黑盒的帖子详情与评论接口要求登录态（未登录会触发人机校验）。请在设置中填入 Cookie 后刷新本页。'
                : esc((payload && payload.msg) || '请稍后重试。')
          }</p>
          <div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center">
            ${
              payload && (payload.needLogin || payload.status === 'show_captcha')
                ? '<button class="btn-primary" onclick="openSettings()">填入 Cookie</button>'
                : ''
            }
            <button class="btn-ghost" onclick="openOriginal('${esc(postUrl(link))}')">在浏览器中打开原文</button>
          </div>
        </div>
      </div>`;
    return;
  }

  const r = payload.result || {};
  const linkData = r.link || {};
  const comments = r.comments || [];

  // 从搜索结果等入口进入时，列表里没缓存该帖信息，用详情补全标题与作者
  if (!link && linkData.title) {
    const head = $('.detail-wrap');
    if (head) {
      head.insertAdjacentHTML(
        'afterbegin',
        `<h1 class="detail-title">${esc(linkData.title)}</h1>` + detailAuthorHTML(linkData)
      );
    }
  }

  // 正文：text 已被主进程拍平成纯文本
  if (linkData.text) {
    const body = $('#detail-body');
    if (body) {
      body.textContent = linkData.text;
      body.style.whiteSpace = 'pre-wrap';
    }
  }

  // 详情接口带回的图片比列表更全
  const detailImgs = linkData.images || [];
  if (detailImgs.length) {
    const holder = $('#detail-imgs');
    const html = detailImgs
      .map((u) => `<img src="${esc(img(u))}" style="max-width:100%;border-radius:9px;margin:6px 0;display:block" onerror="this.style.display='none'"/>`)
      .join('');
    if (holder) holder.innerHTML = html;
    else $('#detail-body') && $('#detail-body').insertAdjacentHTML('afterend', `<div id="detail-imgs">${html}</div>`);
  }

  const total = r.totalFloorNum || comments.length;
  box.innerHTML = `
    <div class="comment-sec">
      <h4>评论 ${total ? `<span style="color:var(--text-3);font-weight:400">${fmtNum(total)}</span>` : ''}</h4>
      ${
        comments.length
          ? comments.map(commentHTML).join('')
          : '<div style="color:var(--text-3);font-size:12.5px;padding:14px 0">暂无评论</div>'
      }
      ${r.hasMoreFloors ? '<div class="load-more" style="font-size:12px">还有更多楼层，请到官方页面查看完整评论</div>' : ''}
    </div>`;
}

function detailAuthorHTML(link) {
  const u = link.user || {};
  return `<div class="detail-author">
    ${u.avatar || u.avartar ? `<img src="${esc(img(u.avatar || u.avartar))}" onerror="this.style.visibility='hidden'"/>` : ''}
    <div>
      <div class="a-name">${esc(u.username || '匿名用户')}${u.level_info && u.level_info.level ? ` <span class="lv">Lv.${esc(u.level_info.level)}</span>` : ''}</div>
      <div class="a-sub">${fmtTime(link.create_at)} · 👍 ${fmtNum(link.link_award_num)} · 💬 ${fmtNum(link.comment_num)}</div>
    </div>
  </div>`;
}

function commentHTML(c, depth = 0) {
  const u = c.user || {};
  const subs = c.sub_comments || [];
  return `<div class="comment${depth ? ' comment-child' : ''}">
    ${u.avatar || u.avartar ? `<img class="c-avatar" src="${esc(img(u.avatar || u.avartar))}" onerror="this.style.visibility='hidden'"/>` : '<div class="c-avatar"></div>'}
    <div class="comment-body">
      <div class="comment-name">${esc(u.username || '匿名用户')}${c.is_link_owner ? ' <span class="lv">楼主</span>' : ''}</div>
      <div class="comment-text">${esc(c.text || '')}</div>
      <div class="comment-foot">
        <span>${fmtTime(c.create_at)}</span>
        ${c.up ? `<span>👍 ${esc(c.up)}</span>` : ''}
        ${c.child_num ? `<span>${esc(c.child_num)} 条回复</span>` : ''}
      </div>
      ${subs.length ? `<div class="comment-sub">${subs.map((s) => commentHTML(s, depth + 1)).join('')}</div>` : ''}
    </div>
  </div>`;
}

function goBack() {
  if (state.currentTopic) {
    state.view = 'topic';
    loadFeed({ reset: true, topic: state.currentTopic });
  } else {
    state.view = 'feed';
    state.currentTopic = null;
    loadFeed({ reset: true });
  }
  setActiveNav(state.view === 'feed' ? 'feed' : null);
}

function openOriginal(url) {
  if (!url) { toast('没有可用的原文链接'); return; }
  window.heybox.openExternal(url);
}

/* ==================== 视图：消息 ==================== */

async function renderMessages() {
  state.view = 'messages';
  state.currentTopic = null;
  setActiveNav('messages');
  $('#content').innerHTML = `
    <div class="content-head"><div class="content-title">我的消息</div></div>
    <div id="msg-box"><div class="skeleton-card"></div></div>`;
  const res = await window.heybox.api.messages(0, 0, 20);
  const payload = res && res.ok ? res.data : null;
  const box = $('#msg-box');
  if (!box) return;

  if (!payload || !payload.ok) {
    box.innerHTML = loginBox(payload, '消息中心需要登录');
    return;
  }

  const r = payload.result || {};
  const messages = r.messages || [];
  const unread = Number(r.message_unread_num) || 0;

  if (!messages.length) {
    box.innerHTML = r.anonymous
      ? stateBox(
          '🔐',
          '消息中心需要登录',
          '未登录时该接口不会报错，只会返回空列表。请在设置中填入小黑盒 Cookie，即可查看回复、点赞与系统通知。',
          '<button class="btn-primary" onclick="openSettings()">填入 Cookie</button>'
        )
      : stateBox('📭', '暂无新消息', unread ? `有 ${unread} 条未读，稍后再刷新看看。` : '还没有收到回复、点赞或系统通知。');
    return;
  }

  box.innerHTML = `<div class="detail-wrap">${messages.map(messageHTML).join('')}</div>`;
}

function messageHTML(m) {
  const u = m.user_a || m.user || {};
  const text = m.text || m.content || m.title || '';
  return `<div class="comment">
    ${u.avartar || u.avatar ? `<img class="c-avatar" src="${esc(img(u.avartar || u.avatar))}" onerror="this.style.visibility='hidden'"/>` : '<div class="c-avatar"></div>'}
    <div class="comment-body">
      <div class="comment-name">${esc(u.username || m.entry || '通知')}</div>
      <div class="comment-text">${esc(text)}</div>
      <div class="comment-foot"><span>${fmtTime(m.timestamp || m.create_at)}</span></div>
    </div>
  </div>`;
}

/* ==================== 导航 / 侧栏 ==================== */

function setActiveNav(view) {
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  if (!view) $$('.nav-item').forEach((el) => el.classList.remove('active'));
  if (view !== 'topic') $$('.topic-item').forEach((el) => el.classList.remove('active'));
}

function renderTopicNav() {
  const box = $('#topic-nav');
  if (!state.topics.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:6px 8px">暂无数据</div>';
    return;
  }
  box.innerHTML = state.topics
    .slice(0, 30)
    .map(
      (t) => `<div class="topic-item" data-topic='${esc(JSON.stringify({ topic_id: t.topic_id, name: t.name }))}'>
        <img src="${esc(img(t.pic_url || t.small_pic_url))}" onerror="this.style.visibility='hidden'"/>
        <span class="t-name">${esc(t.name)}</span>
      </div>`
    )
    .join('');
}

function renderHotList() {
  $('#hot-list').innerHTML = state.topics
    .slice(0, 10)
    .map(
      (t, i) => `<div class="hot-item" data-topic='${esc(JSON.stringify({ topic_id: t.topic_id, name: t.name }))}'>
        <span class="hot-rank r${i + 1}">${i + 1}</span>
        <span class="h-name">${esc(t.name)}</span>
      </div>`
    )
    .join('');
}

function openTopic(topic) {
  state.currentTopic = topic;
  state.view = 'topic';
  $$('.nav-item').forEach((el) => el.classList.remove('active'));
  $$('.topic-item').forEach((el) => {
    let d = null;
    try { d = JSON.parse(el.dataset.topic); } catch { /* ignore */ }
    el.classList.toggle('active', !!d && d.topic_id === topic.topic_id);
  });
  loadFeed({ reset: true, topic });
}

/* ==================== 账号状态 ==================== */

function renderAccount() {
  const box = $('#account-box');
  if (!box) return;
  const prof = state.profile;

  if (state.hasCookie) {
    const avatar = prof && prof.avatar
      ? `<img src="${esc(img(prof.avatar))}" onerror="this.style.visibility='hidden'"/>`
      : '<div style="width:40px;height:40px;border-radius:50%;background:var(--surface-3);flex-shrink:0"></div>';
    box.innerHTML = `
      <div class="acc-profile">
        ${avatar}
        <div style="min-width:0">
          <div class="acc-name">${esc((prof && prof.nickname) || '已登录')}${prof && prof.level ? ` <span class="lv">Lv.${esc(prof.level)}</span>` : ''}</div>
          <div class="acc-sub">${prof && prof.heyboxId ? 'ID ' + esc(prof.heyboxId) : '登录态已保存'}</div>
        </div>
      </div>
      <div class="acc-actions"><button class="btn-ghost" id="acc-logout">退出登录</button></div>
      <p class="acc-hint">已解锁帖子详情、评论、搜索与消息。</p>`;
    $('#acc-logout').onclick = doLogout;
  } else {
    box.innerHTML = `
      <div class="status-row"><span class="status-label">登录状态</span><span class="status-val">未登录</span></div>
      <div class="status-row"><span class="status-label">数据来源</span><span class="status-val ok">api.xiaoheihe.cn</span></div>
      <div class="acc-actions">
        <button class="btn-primary" id="acc-qr">扫码登录</button>
        <button class="btn-ghost" id="acc-cookie">用 Cookie</button>
      </div>
      <p class="acc-hint">登录后可查看帖子详情、评论与消息。</p>`;
    $('#acc-qr').onclick = openLogin;
    $('#acc-cookie').onclick = openSettings;
  }

  const dot = $('#login-dot');
  if (dot) dot.hidden = !state.hasCookie;
}

async function refreshLoginState() {
  const r = await window.heybox.config.get();
  if (r && r.ok) {
    state.hasCookie = !!r.data.hasCookie;
    state.profile = r.data.profile || null;
    state.captchaCooldownMs = r.data.captchaCooldownMs || 0;
  }
  renderAccount();
}

async function doLogout() {
  const r = await window.heybox.auth.logout();
  if (r && r.ok && r.data && r.data.hasCookie === false) {
    state.hasCookie = false;
    state.profile = null;
    renderAccount();
    toast('已退出登录', 'ok');
    loadFeed({ reset: true });
  }
}

/* ==================== 扫码登录 ==================== */

const login = { token: null, pollTimer: null, expireTimer: null, closed: true, retries: 0 };

function setQrStatus(text, cls = '') {
  const el = $('#qr-status');
  if (el) el.className = 'qr-status ' + cls;
  const t = $('#qr-status-text');
  if (t) t.textContent = text;
}

function showQrOverlay(text, detail) {
  const o = $('#qr-overlay');
  if (!o) return;
  o.hidden = false;
  const t = $('#qr-overlay-text');
  if (t) t.textContent = text;
  // 诊断信息单独放在遮罩下方的小字里，不要糊在二维码上
  const d = $('#qr-detail');
  if (d) {
    d.textContent = detail ? String(detail).slice(0, 400) : '';
    d.hidden = !detail;
  }
}

function stopQrTimers() {
  if (login.pollTimer) { clearTimeout(login.pollTimer); login.pollTimer = null; }
  if (login.expireTimer) { clearTimeout(login.expireTimer); login.expireTimer = null; }
}

function openLogin() {
  login.closed = false;
  $('#login-modal').hidden = false;
  startQr();
}

function closeLogin() {
  login.closed = true;
  login.token = null;
  stopQrTimers();
  $('#login-modal').hidden = true;
}

async function startQr() {
  stopQrTimers();
  login.token = null;
  login.retries = 0;
  $('#qr-overlay').hidden = true;
  const wrap = $('.qr-wrap');
  if (wrap) wrap.classList.add('qr-empty');
  setQrStatus('正在生成二维码…');

  const r = await window.heybox.auth.qrCreate();
  const d = r && r.ok ? r.data : null;
  if (!d || !d.ok) {
    setQrStatus((d && d.message) || (r && r.error) || '二维码生成失败', 'err');
    showQrOverlay('二维码生成失败，请点击下方按钮重试');
    return;
  }

  const imgEl = $('#qr-img');
  if (imgEl) imgEl.src = d.qrDataUrl;
  if (wrap) wrap.classList.remove('qr-empty');
  login.token = d.token;
  setQrStatus('请使用「小黑盒」App 扫码');

  // 到期自动标记失效（提前 3 秒，避免与服务器判定打架）
  login.expireTimer = setTimeout(() => {
    stopQrTimers();
    setQrStatus('二维码已过期', 'err');
    showQrOverlay('二维码已过期，请刷新后重新扫码');
  }, Math.max(5, (d.expiresIn || 120) - 3) * 1000);

  pollQr();
}

async function pollQr() {
  if (login.closed || !login.token) return;
  let r = null;
  try {
    r = await window.heybox.auth.qrPoll(login.token);
  } catch { /* IPC 异常按网络重试处理 */ }
  const d = r && r.ok ? r.data : null;

  if (login.closed) return;

  // IPC/网络异常：继续重试，连续 6 次（约 15 秒）仍失败才报错
  if (!d) {
    if (++login.retries >= 6) {
      stopQrTimers();
      setQrStatus('网络异常，状态查询失败', 'err');
      showQrOverlay('网络异常，请检查网络后点击「刷新二维码」');
      return;
    }
    login.pollTimer = setTimeout(pollQr, 2500);
    return;
  }

  switch (d.state) {
    case 'waiting':
    case 'retry': {
      if (d.state === 'retry' && ++login.retries >= 6) {
        stopQrTimers();
        setQrStatus(d.message || '网络异常', 'err');
        showQrOverlay((d.message || '网络异常') + '，请点击「刷新二维码」重试');
        return;
      }
      if (d.state === 'waiting') login.retries = 0;
      setQrStatus(d.message || '请使用「小黑盒」App 扫码');
      login.pollTimer = setTimeout(pollQr, 1800);
      break;
    }

    case 'scanned':
      login.retries = 0;
      setQrStatus('已扫码，请在手机上确认登录', 'ok');
      login.pollTimer = setTimeout(pollQr, 1500);
      break;

    case 'succeeded': {
      stopQrTimers();
      login.token = null;
      state.hasCookie = true;
      state.profile = d.profile || null;
      setQrStatus('登录成功！', 'ok');
      renderAccount();
      toast(d.warn || '登录成功', d.warn ? 'err' : 'ok');
      setTimeout(() => {
        closeLogin();
        loadFeed({ reset: true });
      }, 900);
      break;
    }

    case 'need_google':
      stopQrTimers();
      setQrStatus(d.message || '需要谷歌二次验证', 'err');
      showQrOverlay('该账号需要谷歌二次验证，请改用 Cookie 登录');
      break;

    case 'expired':
      stopQrTimers();
      setQrStatus(d.message || '二维码已失效', 'err');
      showQrOverlay((d.message || '二维码已失效') + '，请刷新后重试');
      break;
    default: {
      stopQrTimers();
      setQrStatus(d.message || '登录失败', 'err');
      showQrOverlay(d.message || '登录失败，请刷新重试', d.detail);
    }
  }
}

/* ==================== 设置（Cookie 手动登录） ==================== */

function openSettings() {
  $('#modal').hidden = false;
}
function closeSettings() {
  $('#modal').hidden = true;
}

/* ==================== 事件绑定 ==================== */

function bindEvents() {
  // 侧栏导航
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    const v = btn.dataset.view;
    if (v === 'feed') { state.currentTopic = null; state.view = 'feed'; setActiveNav('feed'); loadFeed({ reset: true }); }
    else if (v === 'topics') { renderTopicsView(); }
    else if (v === 'messages') { renderMessages(); }
  });

  // 板块点击（侧栏 + 热榜 + 社区网格）
  document.addEventListener('click', (e) => {
    const ti = e.target.closest('[data-topic]');
    if (ti) {
      try { openTopic(JSON.parse(ti.dataset.topic)); } catch { /* ignore */ }
      return;
    }
    const card = e.target.closest('.post-card[data-link]');
    if (card) openDetail(card.dataset.link);
  });

  // 搜索
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(e.target.value);
  });

  // 刷新
  $('#btn-refresh').addEventListener('click', () => {
    if (state.view === 'detail') return;
    if (state.currentTopic) loadFeed({ reset: true, topic: state.currentTopic });
    else loadFeed({ reset: true });
    toast('已刷新', 'ok');
  });

  // 设置
  $('#btn-settings').addEventListener('click', openSettings);
  $('#modal-close').addEventListener('click', closeSettings);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeSettings(); });

  // 扫码登录弹窗
  $('#login-close').addEventListener('click', closeLogin);
  $('#login-modal').addEventListener('click', (e) => { if (e.target.id === 'login-modal') closeLogin(); });
  $('#qr-refresh').addEventListener('click', startQr);
  $('#qr-use-cookie').addEventListener('click', () => { closeLogin(); openSettings(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLogin(); closeSettings(); }
  });

  // 保存 Cookie
  $('#btn-save-cookie').addEventListener('click', async () => {
    const val = $('#cookie-input').value;
    const tip = $('#cookie-tip');
    if (!val.trim()) { tip.className = 'modal-tip err'; tip.textContent = '请输入 Cookie 内容'; return; }
    const r = await window.heybox.config.setCookie(val);
    if (r && r.ok) {
      tip.className = 'modal-tip ok';
      tip.textContent = '已保存，正在校验登录态…';
      await refreshLoginState();
      // 尝试拉取资料，确认 Cookie 是否有效
      const p = await window.heybox.auth.profile();
      if (p && p.ok && p.data && p.data.ok) {
        state.profile = p.data.profile;
        renderAccount();
        tip.textContent = `登录成功：${state.profile.nickname || state.profile.heyboxId || '已登录'}`;
        toast('Cookie 校验通过', 'ok');
        loadFeed({ reset: true });
      } else {
        tip.className = 'modal-tip err';
        tip.textContent = '已保存，但校验未通过（Cookie 可能不完整或已过期）';
      }
      setTimeout(closeSettings, 1100);
    } else {
      tip.className = 'modal-tip err';
      tip.textContent = '保存失败：' + ((r && r.error) || '未知错误');
    }
  });

  // 清除 Cookie
  $('#btn-clear-cookie').addEventListener('click', async () => {
    await window.heybox.auth.logout();
    $('#cookie-input').value = '';
    state.hasCookie = false;
    state.profile = null;
    renderAccount();
    const tip = $('#cookie-tip');
    tip.className = 'modal-tip ok';
    tip.textContent = '已清除本地登录态。';
  });

  // 窗口控制
  $('#win-min').addEventListener('click', () => window.heybox.window.minimize());
  $('#win-max').addEventListener('click', () => window.heybox.window.toggleMaximize());
  $('#win-close').addEventListener('click', () => window.heybox.window.close());
}

/* ==================== 启动 ==================== */

async function boot() {
  bindEvents();
  await refreshLoginState();

  // 关于信息
  const info = await window.heybox.appInfo();
  if (info && info.ok && info.data) {
    $('#about-meta').innerHTML = `v${esc(info.data.version)} · Electron ${esc(info.data.electron)}<br/>数据接口由本地签名代理转发`;
  }

  // 板块数据：热门社区 + 推荐（未登录时 recommend 为空，自动退化为热门）
  const res = await window.heybox.api.categories();
  const payload = res && res.ok ? res.data : null;
  if (payload && payload.ok && payload.result) {
    const r = payload.result;
    const hot = (r.latest_hot_topics && r.latest_hot_topics.children) || [];
    const rec = (r.recommend_for_user_topics && r.recommend_for_user_topics.children) || [];
    const sub = (r.subscribed_topics && r.subscribed_topics.children) || [];
    const all = [...sub, ...rec, ...hot];
    // 按 topic_id 去重，避免订阅板块和热门重复
    const seen = new Set();
    state.topics = all.filter((t) => {
      if (!t || t.topic_id == null) return false;
      const k = String(t.topic_id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  renderTopicNav();
  renderHotList();

  if (!state.topics.length) {
    $('#topic-nav').innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:6px 8px">板块数据加载失败</div>';
  }

  // 首页推荐流
  loadFeed({ reset: true });
}

window.openSettings = openSettings;
window.openLogin = openLogin;
window.openOriginal = openOriginal;
// 供自动化测试直接驱动二维码失败态
window.__showQrOverlayForTest = showQrOverlay;

boot();
