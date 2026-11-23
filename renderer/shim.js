'use strict';
/**
 * 浏览器开发模式的 window.heybox 垫片。
 * Electron 下 preload 已注入 window.heybox，本脚本自动跳过；
 * 纯浏览器环境下用 HTTP RPC 实现同一套接口，方便不装依赖直接预览 UI。
 */
(function () {
  if (window.heybox) return; // Electron 环境

  const rpc = (fn, args = []) =>
    fetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args }),
    }).then((r) => r.json());

  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());

  const get = (url) => fetch(url).then((r) => r.json());

  window.heybox = {
    appInfo: () => get('/appinfo'),

    config: {
      get: () => get('/config'),
      setCookie: (cookie) => post('/config/cookie', { cookie }),
    },

    auth: {
      qrCreate: () => get('/auth/qr/create'),
      qrPoll: (token) => post('/auth/qr/poll', { token }),
      profile: () => get('/auth/profile'),
      logout: () => post('/auth/logout'),
    },

    api: {
      feeds: (offset, limit, pull) => rpc('feeds', [offset, limit, pull]),
      categories: () => rpc('categories', []),
      topicFeeds: (topicId, offset, limit, sortType) => rpc('topicFeeds', [topicId, offset, limit, sortType]),
      linkTree: (linkId, page, limit, index, ownerOnly) =>
        rpc('linkTree', [linkId, { page, limit, index, ownerOnly }]),
      search: (q, type, offset, limit) => rpc('search', [q, { type, offset, limit }]),
      searchTopics: (q, offset, limit) => rpc('searchTopics', [q, offset, limit]),
      messages: (listType, offset, limit) => rpc('messages', [{ listType, offset, limit }]),
      raw: () => Promise.resolve({ ok: false, error: '浏览器预览模式不支持该接口' }),
    },

    openExternal: (url) => window.open(url, '_blank'),

    window: {
      minimize() {}, toggleMaximize() {}, close() {},
      isMaximized: async () => false,
      onMaximized() {},
    },

    img: (rawUrl) => (rawUrl ? '/img?u=' + encodeURIComponent(rawUrl) : ''),
  };
})();
