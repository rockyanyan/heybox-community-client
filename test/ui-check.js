'use strict';
/**
 * 用无头 Edge 截图验证渲染层：真实数据是否正常上屏、控制台是否报错。
 * 用法：node test/ui-check.js [url] [输出png]
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9444;
const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'heybox-ui-check.png');
const profileDir = path.join(os.tmpdir(), 'edge-ui-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

(async () => {
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

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
  const logs = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
      logs.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'error') errors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || 'exception');
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(7000);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  };

  const stats = await evalJs(`(() => {
    const cards = document.querySelectorAll('.post-card[data-link]');
    const topics = document.querySelectorAll('.topic-item');
    const hot = document.querySelectorAll('.hot-item');
    const first = cards[0];
    const img = first && first.querySelector('img');
    return {
      cards: cards.length,
      topics: topics.length,
      hot: hot.length,
      firstTitle: first && (first.querySelector('.post-title') || {}).textContent,
      firstAuthor: first && (first.querySelector('.post-author span') || {}).textContent,
      firstImgSrc: img && img.src.slice(0, 60),
      firstImgLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
      accountText: (document.querySelector('#account-box') || {}).textContent?.trim().slice(0, 60),
      skeletons: document.querySelectorAll('.skeleton-card').length,
      stateBox: (document.querySelector('.state-box') || {}).textContent,
    };
  })()`);

  console.log('=== DOM 统计 ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '(无)');

  await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then((r) => {
    fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
    console.log('\n截图已保存:', OUT);
  });

  child.kill();
  await sleep(400);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(errors.length ? 1 : 0);
})();
