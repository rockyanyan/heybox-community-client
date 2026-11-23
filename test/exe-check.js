'use strict';
/**
 * 验证打包后的 exe 真实渲染：连上 elecron 的 CDP，检查 DOM、图片与截图。
 * 用法：node test/exe-check.js [cdpPort] [输出png]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = process.argv[2] || 9222;
const OUT = process.argv[3] || path.join(os.tmpdir(), 'heybox-exe.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  on(fn) { this.handlers.push(fn); }
}

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  if (!cond) failed++;
};

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面 target');

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

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result && r.result.value;
  };

  console.log('== 打包版运行状态 ==');
  const loadState = await ev(`(() => {
    const sample = window.heybox && window.heybox.img ? window.heybox.img('https://imgheybox1.max-c.com/x.png') : '';
    return {
      url: location.href,
      hasHeyboxApi: typeof window.heybox === 'object' && !!window.heybox.api,
      isElectron: !!window.heybox && typeof window.heybox.img === 'function',
      imgSample: sample,
      imgExpected: 'hbimg://i/' + encodeURIComponent('https://imgheybox1.max-c.com/x.png'),
    };
  })()`);
  check('页面加载于 app.asar', String(loadState.url || '').includes('app.asar'), loadState.url && loadState.url.slice(0, 60));
  check('preload 注入 window.heybox', loadState.hasHeyboxApi === true);
  check('图片走 hbimg 自定义协议', loadState.imgSample === loadState.imgExpected, loadState.imgSample);

  // 等首屏数据
  await sleep(6000);

  const stats = await ev(`(() => {
    const cards = [...document.querySelectorAll('.post-card[data-link]')];
    const imgs = [...document.querySelectorAll('.post-card img')];
    const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0);
    const broken = imgs.filter(i => i.complete && i.naturalWidth === 0);
    return {
      cards: cards.length,
      topics: document.querySelectorAll('.topic-item').length,
      hot: document.querySelectorAll('.hot-item').length,
      imgTotal: imgs.length,
      imgLoaded: loaded.length,
      imgBroken: broken.length,
      firstTitle: cards[0] && (cards[0].querySelector('.post-title') || {}).textContent,
      firstAuthor: cards[0] && (cards[0].querySelector('.post-author span') || {}).textContent,
      skeletons: document.querySelectorAll('.skeleton-card').length,
      aboutVersion: (document.querySelector('#about-meta') || {}).textContent,
    };
  })()`);

  console.log('\n== 真实数据渲染 ==');
  check('推荐流有内容', stats.cards >= 10, { cards: stats.cards });
  check('侧栏板块已加载', stats.topics > 0, { topics: stats.topics });
  check('热榜已加载', stats.hot > 0, { hot: stats.hot });
  check('图片经 hbimg 代理成功加载', stats.imgLoaded > 0 && stats.imgBroken === 0,
    { total: stats.imgTotal, loaded: stats.imgLoaded, broken: stats.imgBroken });
  check('骨架屏已替换为真实内容', stats.skeletons === 0, { skeletons: stats.skeletons });
  check('版本号来自打包信息', /1\.1\.0/.test(stats.aboutVersion || '') && /Electron/.test(stats.aboutVersion || ''),
    stats.aboutVersion);

  console.log('\n== 交互（打包版） ==');
  await ev("document.querySelector('#content').scrollTop = document.querySelector('#content').scrollHeight");
  await sleep(3000);
  const afterScroll = await ev("document.querySelectorAll('.post-card[data-link]').length");
  check('滚动加载生效', afterScroll > stats.cards, { before: stats.cards, after: afterScroll });

  const dupCheck = await ev(`(() => {
    const ids = [...document.querySelectorAll('.post-card[data-link]')].map(e => e.dataset.link);
    return { total: ids.length, uniq: new Set(ids).size };
  })()`);
  check('无重复卡片', dupCheck.total === dupCheck.uniq, dupCheck);

  await ev("document.querySelector('#acc-qr')?.click()");
  await sleep(3500);
  const qr = await ev(`(() => {
    const img = document.querySelector('#qr-img');
    return { visible: !document.querySelector('#login-modal').hidden, srcLen: img ? img.src.length : 0 };
  })()`);
  check('扫码弹窗在打包版可用', qr.visible && qr.srcLen > 1000, qr);

  await ev("document.querySelector('#login-close')?.click()");
  await sleep(600);

  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '(无)');
  if (errors.length) failed++;

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('\n截图:', OUT);

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
