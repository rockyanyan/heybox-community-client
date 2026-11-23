'use strict';
/**
 * 验证扫码失败时的展示：诊断信息应出现在 #qr-detail 独立区域，
 * 不再糊在二维码上（这是 v1.1.0 用户报的显示问题）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9466;
const BASE = process.env.UI_BASE || 'http://127.0.0.1:5173/';
const OUT = path.join(os.tmpdir(), 'heybox-qr-fail.png');
const profileDir = path.join(os.tmpdir(), 'edge-qrfail-' + Date.now());
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

let failed = 0;
const check = (n, c, e) => { console.log(`  ${c ? '✅' : '❌'} ${n}${e !== undefined ? ' -> ' + JSON.stringify(e) : ''}`); if (!c) failed++; };

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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(5000);

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result && r.result.value;
  };

  // 强制走失败分支，检查诊断信息落在独立区域
  await ev(`(() => {
    document.querySelector('#login-modal').hidden = false;
    const demoDetail = 'heybox_id="44792041" pkey="(无)" result={"profile":{},"account_detail":{"userid":"44792041"}}';
    if (window.__showQrOverlayForTest) { window.__showQrOverlayForTest('登录响应缺少登录态字段', demoDetail); }
    return true;
  })()`);

  await sleep(800);

  const layout = await ev(`(() => {
    const overlay = document.querySelector('#qr-overlay');
    const overlayText = document.querySelector('#qr-overlay-text');
    const detail = document.querySelector('#qr-detail');
    const wrap = document.querySelector('.qr-wrap');
    const wrapBox = wrap ? wrap.getBoundingClientRect() : null;
    const overlayBox = overlay ? overlay.getBoundingClientRect() : null;
    return {
      hasDetailEl: !!detail,
      overlayTextLen: overlayText ? overlayText.textContent.length : 0,
      overlayTextIncludesDiagnostics: overlayText ? /heybox_id|result=|diagnostic/i.test(overlayText.textContent) : null,
      overlayInsideWrap: !!(wrapBox && overlayBox && overlayBox.top >= wrapBox.top - 1 && overlayBox.bottom <= wrapBox.bottom + 1),
      detailVisible: detail ? !detail.hidden : null,
      detailOutsideWrap: !!(detail && wrapBox && detail.getBoundingClientRect().top > wrapBox.bottom),
    };
  })()`);

  console.log('== 扫码失败展示 ==');
  check('#qr-detail 元素存在', layout.hasDetailEl, layout.hasDetailEl);
  check('诊断文本不再压在二维码遮罩里', layout.overlayTextIncludesDiagnostics === false, layout.overlayTextLen);
  check('遮罩仍在二维码框内', layout.overlayInsideWrap === true, layout.overlayInsideWrap);
  check('诊断信息渲染在二维码下方独立区域', layout.detailOutsideWrap === true, layout.detailOutsideWrap);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('\n截图:', OUT);

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  child.kill();
  await sleep(300);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
