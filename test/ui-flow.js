'use strict';
/**
 * 交互回归：滚动加载、板块切换、搜索/详情在风控下的降级提示。
 * 用法：node test/ui-flow.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9455;
const BASE = process.env.UI_BASE || 'http://127.0.0.1:5173/';
const profileDir = path.join(os.tmpdir(), 'edge-flow-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  on(fn) { this.handlers.push(fn); }
}

(async () => {
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!targets) { console.log('EDGE 启动失败'); child.kill(); process.exit(1); }

  const page = targets.find((t) => t.type === 'page');
  const cdp = new CDP(new WebSocket(page.webSocketDebuggerUrl));
  await new Promise((r) => cdp.ws.addEventListener('open', r));

  const errors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(6000);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result && r.result.value;
  };

  let failed = 0;
  const check = (name, cond, extra) => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + JSON.stringify(extra) : ''}`);
    if (!cond) failed++;
  };

  console.log('== 首屏 ==');
  const first = await ev("document.querySelectorAll('.post-card[data-link]').length");
  check('推荐流首屏有内容', first >= 10, { cards: first });

  console.log('\n== 滚动加载（服务端每页 10 条，offset 必须按实际条数推进） ==');
  for (let i = 0; i < 3; i++) {
    await ev("document.querySelector('#content').scrollTop = document.querySelector('#content').scrollHeight");
    await sleep(2600);
  }
  const after = await ev("document.querySelectorAll('.post-card[data-link]').length");
  check('滚动后条数增长', after > first, { before: first, after: after });

  const dup = await ev(`(() => {
    const ids = [...document.querySelectorAll('.post-card[data-link]')].map(e => e.dataset.link);
    return { total: ids.length, uniq: new Set(ids).size };
  })()`);
  check('列表无重复卡片', dup.total === dup.uniq, dup);

  console.log('\n== 板块切换 ==');
  const topicClick = await ev(`(() => {
    const el = document.querySelector('.topic-item');
    if (!el) return null;
    el.click();
    return el.querySelector('.t-name')?.textContent;
  })()`);
  await sleep(3000);
  const topicCards = await ev("document.querySelectorAll('.post-card[data-link]').length");
  check('板块帖子加载', topicCards > 0, { topic: topicClick, cards: topicCards });

  console.log('\n== 全部社区 ==');
  await ev("document.querySelector('.nav-item[data-view=topics]').click()");
  await sleep(800);
  const grid = await ev("document.querySelectorAll('#topics-grid .post-card').length");
  check('社区网格渲染', grid > 0, { tiles: grid });

  console.log('\n== 搜索（匿名会被风控，需给出可操作提示而不是空白） ==');
  await ev(`(() => {
    const i = document.querySelector('#search-input');
    i.value = '塞尔达';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(3500);
  const search = await ev(`(() => {
    const box = document.querySelector('.state-box');
    return {
      cards: document.querySelectorAll('.post-card[data-link]').length,
      stateTitle: box ? box.querySelector('h4')?.textContent : null,
      hasAction: !!(box && box.querySelector('button')),
    };
  })()`);
  check('搜索有结果或给出提示', search.cards > 0 || !!search.stateTitle, search);

  console.log('\n== 详情（风控降级） ==');
  await ev("document.querySelector('.nav-item[data-view=feed]').click()");
  await sleep(3000);
  await ev("const c=document.querySelector('.post-card[data-link]'); if(c) c.click();");
  await sleep(4000);
  const detail = await ev(`(() => {
    const lock = document.querySelector('.detail-lock');
    return {
      hasTitle: !!document.querySelector('.detail-title'),
      hasBack: !!document.querySelector('.detail-back'),
      lockTitle: lock ? lock.querySelector('h4')?.textContent : null,
      lockHasAction: !!(lock && lock.querySelector('button')),
    };
  })()`);
  check('详情页有标题与返回', detail.hasTitle && detail.hasBack, detail);
  check('风控时给出可操作提示', !detail.lockTitle || detail.lockHasAction, detail);

  console.log('\n== 消息（匿名） ==');
  await ev("document.querySelector('.nav-item[data-view=messages]').click()");
  await sleep(2500);
  const msg = await ev(`(() => {
    const box = document.querySelector('.state-box');
    return { title: box ? box.querySelector('h4')?.textContent : null, hasAction: !!(box && box.querySelector('button')) };
  })()`);
  check('消息页提示需要登录', !!msg.title, msg);

  console.log('\n== 扫码登录弹窗 ==');
  await ev("document.querySelector('.nav-item[data-view=feed]').click()");
  await sleep(1500);
  await ev("document.querySelector('#acc-qr')?.click()");
  await sleep(4000);
  const qr = await ev(`(() => {
    const img = document.querySelector('#qr-img');
    return {
      visible: !document.querySelector('#login-modal').hidden,
      srcLen: img ? img.src.length : 0,
      status: document.querySelector('#qr-status-text')?.textContent,
    };
  })()`);
  check('二维码弹窗渲染', qr.visible && qr.srcLen > 1000, qr);

  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '(无)');
  if (errors.length) failed++;

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.writeFileSync(path.join(os.tmpdir(), 'heybox-ui-flow.png'), Buffer.from(r.data, 'base64'));
  });

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  child.kill();
  await sleep(400);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
})();
