'use strict';
/* 验证修复后的扫码登录逻辑：真实 create/poll + 模拟成功路径 */
const heybox = require('../src/heybox');

(async () => {
  console.log('=== 1) 真实创建 + 轮询（等待扫码） ===');
  const c = await heybox.createQrLogin();
  console.log('创建:', c.ok ? 'ok' : JSON.stringify(c), '| token=', c.token);
  const p1 = await heybox.pollQrLogin(c.token);
  console.log('轮询#1:', JSON.stringify(p1));
  const p2 = await heybox.pollQrLogin(c.token);
  console.log('轮询#2:', JSON.stringify(p1) === JSON.stringify(p2) ? '(同上, wait 稳定)' : JSON.stringify(p2));

  console.log('\n=== 2) 无效 token（应返回 expired 且带信息） ===');
  const bad = await heybox.pollQrLogin('not-a-real-token-xyz');
  console.log(JSON.stringify(bad));

  console.log('\n=== 3) 模拟登录成功响应（字段提取/Cookie 组装） ===');
  const fake = {
    error: 'ok',
    pkey: 'PKEY123',
    x_xhh_heyboxid: '999',
    profile: { heybox_id: '8888', nickname: '测试用户', avatar: 'http://x/a.png' },
    account_detail: { userid: '8888', username: '测试用户', level_info: { level: 5 } },
  };
  const prof = heybox.buildLoginCookie;
  // 直接调用内部逻辑：通过 request mock 不可行，改为手动构造
  const extracted = {
    heyboxId: fake.profile.heybox_id || fake.account_detail.userid,
    nickname: fake.profile.nickname,
    avatar: fake.profile.avatar,
    level: fake.account_detail.level_info.level,
  };
  console.log('extractProfile:', JSON.stringify(extracted));
  console.log('buildLoginCookie:', prof({ heyboxId: extracted.heyboxId, pkey: fake.pkey, xXhh: fake.x_xhh_heyboxid, setCookie: ['sessionid=abc; Path=/', 'pkey=OLD; Path=/'] }));

  console.log('\n=== 4) 未登录时 getProfile（应优雅返回） ===');
  const gp = await heybox.getProfile();
  console.log(JSON.stringify(gp));
})();
