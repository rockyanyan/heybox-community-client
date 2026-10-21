'use strict';
/**
 * 预加载脚本：通过 contextBridge 暴露受控的 API 给渲染进程。
 * 渲染进程无法直接访问 Node / 网络，所有请求都经主进程完成。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('heybox', {
  appInfo: () => invoke('app:info'),

  config: {
    get: () => invoke('config:get'),
    setCookie: (cookie) => invoke('config:setCookie', { cookie }),
  },

  auth: {
    qrCreate: () => invoke('auth:qrCreate'),
    qrPoll: (token) => invoke('auth:qrPoll', { token }),
    profile: () => invoke('auth:profile'),
    logout: () => invoke('auth:logout'),
  },

  api: {
    feeds: (offset, limit, pull) => invoke('api:feeds', { offset, limit, pull }),
    categories: () => invoke('api:categories'),
    topicFeeds: (topicId, offset, limit, sortType) =>
      invoke('api:topicFeeds', { topicId, offset, limit, sortType }),
    linkTree: (linkId, offset, limit) => invoke('api:linkTree', { linkId, offset, limit }),
    search: (q, offset, limit) => invoke('api:search', { q, offset, limit }),
    raw: (path, params) => invoke('api:raw', { path, params }),
  },

  openExternal: (url) => invoke('shell:open', { url }),

  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
    onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),
  },

  /** 把原始图片地址转成走代理的地址 */
  img: (rawUrl) => {
    if (!rawUrl) return '';
    if (rawUrl.startsWith('hbimg://')) return rawUrl;
    return 'hbimg://i/' + encodeURIComponent(rawUrl);
  },
});
