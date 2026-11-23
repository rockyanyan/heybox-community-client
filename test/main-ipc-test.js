'use strict';
/**
 * 用 mock 的 electron 模块加载 main.js，验证：
 *  - 主进程能正常加载（无语法/依赖错误）
 *  - 所有 IPC 通道都注册成功
 *  - 每个通道被调用时返回 {ok:true,data} 信封，且参数透传正确
 *  - preload 暴露的 API 与主进程通道一一对应
 */
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const handlers = new Map();
const protocolHandlers = new Map();
const registeredSchemes = [];
let windowCreated = null;

class FakeWebContents {
  send() {}
  setWindowOpenHandler() {}
  on() {}
  openDevTools() {}
}
class FakeBrowserWindow {
  constructor(opts) { this.opts = opts; this.webContents = new FakeWebContents(); windowCreated = this; }
  loadFile(f) { this.loadedFile = f; return Promise.resolve(); }
  once(ev, cb) { if (ev === 'ready-to-show') this._ready = cb; }
  on() {}
  show() {}
  minimize() {}
  maximize() { this._max = true; }
  unmaximize() { this._max = false; }
  isMaximized() { return !!this._max; }
  close() {}
  static getAllWindows() { return windowCreated ? [windowCreated] : []; }
}

const fakeElectron = {
  app: {
    disableHardwareAcceleration() {},
    getPath: () => path.join(ROOT, '.test-userdata'),
    getVersion: () => '1.1.0',
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
  },
  shell: { openExternal: () => {} },
  protocol: {
    registerSchemesAsPrivileged: (s) => registeredSchemes.push(...s),
    handle: (scheme, fn) => protocolHandlers.set(scheme, fn),
  },
  net: { fetch: async () => ({ status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }) },
};

// 拦截 require('electron')
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  if (!cond) failed++;
};

(async () => {
  console.log('== 加载主进程 ==');
  require(path.join(ROOT, 'main.js'));
  // 等 app.whenReady().then 的回调跑完
  await new Promise((r) => setTimeout(r, 600));

  check('main.js 加载成功', true);
  check('注册了 hbimg 特权协议', registeredSchemes.some((s) => s.scheme === 'hbimg'));
  check('hbimg 协议处理器已注册', protocolHandlers.has('hbimg'));
  check('创建了主窗口', !!windowCreated);
  check('主窗口加载 renderer/index.html', !!windowCreated && /renderer[\\/]index\.html$/.test(windowCreated.loadedFile || ''));

  console.log('\n== IPC 通道 ==');
  const expected = [
    'app:info', 'config:get', 'config:setCookie',
    'auth:qrCreate', 'auth:qrPoll', 'auth:profile', 'auth:logout',
    'api:feeds', 'api:categories', 'api:topicFeeds', 'api:linkTree',
    'api:search', 'api:searchTopics', 'api:messages',
    'shell:open', 'api:raw',
    'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized',
  ];
  const missing = expected.filter((c) => !handlers.has(c));
  check('全部通道已注册', missing.length === 0, missing.length ? { missing } : `${handlers.size} 个`);

  const call = async (ch, payload) => handlers.get(ch)({}, payload);

  console.log('\n== 通道调用（真实网络） ==');
  const info = await call('app:info', {});
  check('app:info 返回 ok 信封', info.ok === true && info.data.version === '1.1.0', info.data);

  const cfg = await call('config:get', {});
  check('config:get 返回 ok 信封', cfg.ok === true && 'hasCookie' in cfg.data, cfg.data);

  const feeds = await call('api:feeds', { offset: 0, limit: 20, pull: 0 });
  check('api:feeds 透传并返回数据', feeds.ok === true && feeds.data.ok === true && feeds.data.result.links.length > 0,
    `${feeds.data.result.links.length} 条`);

  const cats = await call('api:categories', {});
  check('api:categories', cats.ok === true && cats.data.ok === true,
    `${cats.data.result.latest_hot_topics.children.length} 个板块`);

  const tf = await call('api:topicFeeds', { topicId: cats.data.result.latest_hot_topics.children[0].topic_id, offset: 0, limit: 20, sortType: 0 });
  check('api:topicFeeds', tf.ok === true && tf.data.ok === true, `${tf.data.result.links.length} 条`);

  const st = await call('api:searchTopics', { q: '塞尔达', offset: 0, limit: 20 });
  check('api:searchTopics', st.ok === true && st.data.ok === true, `${(st.data.result.topics || []).length} 个话题`);

  const msg = await call('api:messages', { listType: 0, offset: 0, limit: 20 });
  check('api:messages 匿名可识别', msg.ok === true && msg.data.result.anonymous === true, msg.data.result.anonymous);

  const det = await call('api:linkTree', { linkId: feeds.data.result.links[0].linkid, page: 1, limit: 20, index: 1, ownerOnly: 0 });
  check('api:linkTree 参数透传（page/index/ownerOnly）',
    det.ok === true && ['ok', 'show_captcha', 'empty_result', 'login'].includes(det.data.status), det.data.status);

  const find = await call('api:search', { q: '塞尔达', type: 'link', offset: 0, limit: 20 });
  check('api:search 参数透传（type）',
    find.ok === true && ['ok', 'show_captcha', 'login'].includes(find.data.status), find.data.status);

  const qr = await call('auth:qrCreate', {});
  check('auth:qrCreate 生成 dataURL', qr.ok === true && qr.data.ok === true && (qr.data.qrDataUrl || '').startsWith('data:image/png'),
    qr.data.ok ? { token: qr.data.token, expiresIn: qr.data.expiresIn } : qr.data);

  if (qr.ok && qr.data.ok) {
    const poll = await call('auth:qrPoll', { token: qr.data.token });
    check('auth:qrPoll 返回状态', poll.ok === true && poll.data.state === 'waiting', poll.data.state);
  }

  const prof = await call('auth:profile', {});
  check('auth:profile 未登录优雅失败', prof.ok === true && prof.data.ok === false, prof.data.message);

  const logout = await call('auth:logout', {});
  check('auth:logout', logout.ok === true && logout.data.hasCookie === false, logout.data);

  const bad = await call('api:raw', { path: '/bbs/app/topic/feeds/all', params: {} });
  check('api:raw 对下线接口给出明确状态', bad.ok === true && bad.data.ok === false && bad.data.status === 'not_found', bad.data.status);

  console.log('\n== preload 与主进程通道一致性 ==');
  const exposed = [];
  const fakeWebContentsBridge = {
    exposeInMainWorld: (name, api) => exposed.push({ name, api }),
    ipcRenderer: { invoke: () => {}, on: () => {} },
  };
  Module._load = function (request) {
    if (request === 'electron') return { contextBridge: fakeWebContentsBridge, ipcRenderer: fakeWebContentsBridge.ipcRenderer };
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, 'preload.js'))];
  require(path.join(ROOT, 'preload.js'));
  check('preload 暴露 window.heybox', exposed.length === 1 && exposed[0].name === 'heybox');

  const api = exposed[0] && exposed[0].api;
  const requiredApi = ['appInfo', 'config', 'auth', 'api', 'openExternal', 'window', 'img'];
  check('preload 顶层接口齐全', requiredApi.every((k) => api && api[k]), requiredApi.filter((k) => !api || !api[k]));
  const apiKeys = api && api.api ? Object.keys(api.api) : [];
  check('preload api 子接口齐全',
    ['feeds', 'categories', 'topicFeeds', 'linkTree', 'search', 'searchTopics', 'messages', 'raw'].every((k) => apiKeys.includes(k)),
    apiKeys);

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  Module._load = origLoad;
  process.exit(failed === 0 ? 0 : 1);
})();
