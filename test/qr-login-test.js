'use strict';
/*
 * 扫码登录回归：真实 create/poll + 成功路径的字段提取与 Cookie 组装。
 * 真机扫码无法自动化，成功分支用官方返回结构的样本做断言。
 */
const heybox = require('../src/heybox');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  if (!cond) failed++;
};

(async () => {
  console.log('=== 1) 真实创建 + 轮询（等待扫码） ===');
  const c = await heybox.createQrLogin();
  check('创建二维码', c.ok && !!c.token, c.ok ? { token: c.token, expiresIn: c.expiresIn } : c);
  if (c.ok) {
    check('qr_url 与官方一致', /^https:\/\/api\.xiaoheihe\.cn\/account\/qr_login\/\?qr=[\w-]+&app=web$/.test(c.url), c.url);
    const p1 = await heybox.pollQrLogin(c.token);
    check('未扫码时状态为 waiting', p1.state === 'waiting', p1.state);
    const p2 = await heybox.pollQrLogin(c.token);
    check('重复轮询状态稳定', p2.state === 'waiting', p2.state);
  }

  console.log('\n=== 2) 无效 token ===');
  const bad = await heybox.pollQrLogin('not-a-real-token-xyz');
  check('无效 token 归为 expired', bad.state === 'expired', bad);

  console.log('\n=== 3) 成功响应的字段提取（官方结构样本） ===');
  const fake = {
    error: 'ok',
    pkey: 'PKEY123',
    x_xhh_heyboxid: '999',
    profile: { heybox_id: '8888', nickname: '测试用户', avatar: 'https://imgheybox.max-c.com/a.png' },
    account_detail: { userid: '8888', username: '测试用户', level_info: { level: 5 } },
  };
  const prof = heybox.extractProfile(fake);
  check('资料字段提取', prof.heyboxId === '8888' && prof.nickname === '测试用户' && prof.level === 5, prof);

  const cookie = heybox.buildLoginCookie({
    heyboxId: prof.heyboxId,
    pkey: fake.pkey,
    xXhh: fake.x_xhh_heyboxid,
    setCookie: ['sessionid=abc; Path=/', 'pkey=OLD; Path=/'],
  });
  check('Cookie 含 heybox_id', /(^|;\s*)heybox_id=8888/.test(cookie), cookie);
  check('Cookie 含 user_pkey', /(^|;\s*)user_pkey=PKEY123/.test(cookie));
  check('会话 Cookie 被保留', /sessionid=abc/.test(cookie));
  check('核心字段覆盖同名旧值', !/pkey=OLD/.test(cookie));

  console.log('\n=== 3b) pkey 缺失（新版风控账号，只有 heybox_id + account_detail） ===');
  // 真实遇到的情况：result 里没有 pkey，只有 heybox_id 和完整资料
  const noPkey = {
    error: 'ok',
    heybox_id: '44792041',
    account_detail: { userid: '44792041', username: 'Yan_()', level_info: { level: 14 } },
  };
  const p2 = heybox.extractProfile(noPkey);
  check('仍能提取用户标识', p2.heyboxId === '44792041' && p2.nickname === 'Yan_()', p2);
  const cookie2 = heybox.buildLoginCookie({ heyboxId: p2.heyboxId, pkey: '', setCookie: ['sessionid=xyz'] });
  check('pkey 缺失仍能组装出可用 Cookie',
    /heybox_id=44792041/.test(cookie2) && /sessionid=xyz/.test(cookie2) && !/pkey=/.test(cookie2),
    cookie2);

  console.log('\n=== 4) 未登录时 getProfile ===');
  const gp = await heybox.getProfile();
  check('优雅返回 needLogin', gp.ok === false, gp);

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  process.exit(failed === 0 ? 0 : 1);
})();
