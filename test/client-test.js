'use strict';
// 用真实接口验证 src/heybox.js 的数据链路（匿名部分）+ 纯函数自检
const heybox = require('../src/heybox');
const { getHkey, signUrl, normalizePath } = require('../src/hkey');

const strip = (s, n = 60) => String(s || '').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + extra : ''}`);
  if (!cond) failed++;
};

(async () => {
  console.log('== 纯函数自检 ==');
  check('hkey 已知向量', getHkey('/account/data_report_web/', 1770529394, '3D6891C5FEBD5A0A4C986784D2F60E81') === '3XX1P62');
  check('路径归一化', normalizePath('/bbs/app/feeds') === '/bbs/app/feeds/');
  const signed = new URL(signUrl('https://api.xiaoheihe.cn/bbs/app/feeds?a=1')).searchParams;
  check('签名参数齐全', !!signed.get('hkey') && !!signed.get('_time') && (signed.get('nonce') || '').length === 32);

  check(
    'HTML 去标签',
    heybox.htmlToText('单日差评<em>暴涨</em>3600+条') === '单日差评暴涨3600+条',
    heybox.htmlToText('单日差评<em>暴涨</em>3600+条')
  );

  const rich = heybox.parseRichText(
    JSON.stringify([
      { type: 'text', text: '第一段' },
      { type: 'img', url: 'https://imgheybox.max-c.com/a.png' },
      { type: 'text', text: '第二段<br>换行' },
    ])
  );
  check('文本块解析', rich.text.includes('第一段') && rich.text.includes('第二段') && rich.images.length === 1, JSON.stringify(rich));

  const comments = heybox.normalizeComments([
    { comment: [{ commentid: 1, text: 'a', user: { username: 'u' }, comments: [{ commentid: 2, text: 'b' }] }] },
  ]);
  check('评论分组拍平', comments.length === 1 && comments[0].sub_comments.length === 1, '含 1 条楼中楼');

  check(
    'Cookie 组装（核心字段覆盖同名）',
    heybox.buildLoginCookie({
      heyboxId: '8888',
      pkey: 'PK',
      xXhh: '999',
      setCookie: ['pkey=OLD', 'sess=1'],
    }) === 'pkey=PK; sess=1; heybox_id=8888; user_heybox_id=8888; x_xhh_heyboxid=999; user_pkey=PK'
  );

  check(
    '风控冷却按接口分组',
    (() => {
      heybox.resetCaptcha();
      heybox.noteCaptcha('/bbs/app/link/tree');
      const linkCooled = heybox.captchaCooldownRemainingMs('/bbs/app/link/tree') > 0;
      const feedFree = heybox.captchaCooldownRemainingMs('/bbs/app/feeds') === 0;
      heybox.resetCaptcha();
      return linkCooled && feedFree;
    })()
  );

  console.log('\n== 匿名接口 ==');
  const cat = await heybox.getCategories();
  const hot = (cat.result && cat.result.latest_hot_topics && cat.result.latest_hot_topics.children) || [];
  check('板块分类', cat.ok && hot.length > 0, `热门社区 ${hot.length} 个`);

  const feed = await heybox.getFeeds(0, 20, 0);
  const links = (feed.result && feed.result.links) || [];
  check('推荐流', feed.ok && links.length > 0, `${links.length} 条（服务端每页固定 10，limit 无效）`);
  links.slice(0, 3).forEach((l, i) => {
    console.log(`    ${i + 1}. ${strip(l.title, 24)} | ${l.user && l.user.username} | 赞=${l.link_award_num} 评=${l.comment_num}`);
  });

  // 分页推进：offset 按实际条数累加，第 2 页不应重复
  const second = await heybox.getFeeds(links.length, 20, 0);
  const links2 = (second.result && second.result.links) || [];
  const ids1 = new Set(links.map((l) => l.linkid));
  const dup = links2.filter((l) => ids1.has(l.linkid)).length;
  check('推荐流分页无重复', links2.length > 0 && dup === 0, `第 2 页 ${links2.length} 条，重复 ${dup}`);

  const t0 = hot[0];
  if (t0) {
    const tf = await heybox.getTopicFeeds(t0.topic_id, 0, 20, 0);
    const tlinks = (tf.result && tf.result.links) || [];
    check(`板块帖子（${t0.name}）`, tf.ok && tlinks.length > 0, `${tlinks.length} 条`);
  }

  const st = await heybox.searchTopics('塞尔达', 0, 20);
  check('话题搜索（匿名可用）', st.ok && ((st.result && st.result.topics) || []).length > 0, `${((st.result && st.result.topics) || []).length} 个话题`);

  const msg = await heybox.getMessages();
  check('消息接口匿名可识别', msg.ok && msg.result.anonymous === true, `anonymous=${msg.result && msg.result.anonymous}`);

  const det = await heybox.getLinkTree(links[0] && links[0].linkid, { page: 1, limit: 20 });
  console.log(`  ℹ️ 详情接口：status=${det.status} needLogin=${det.needLogin}（匿名会被风控拦截，属预期）`);
  check(
    '详情接口给出明确状态',
    ['ok', 'show_captcha', 'login', 'empty_result'].includes(det.status) && (det.ok ? !!(det.result && det.result.link) : true),
    det.status
  );

  const s = await heybox.search('塞尔达', { type: 'link' });
  console.log(`  ℹ️ 搜索接口：status=${s.status} needLogin=${s.needLogin}（匿名会被风控拦截，属预期）`);
  check('搜索接口状态可归类', ['ok', 'show_captcha', 'login', 'captcha_cooldown'].includes(s.status), s.status);

  console.log('\n== 扫码登录（推荐流等不受风控影响） ==');
  const qr = await heybox.createQrLogin();
  check('创建二维码', qr.ok && !!qr.token, qr.token ? 'token=' + qr.token : qr.message);
  if (qr.ok) {
    const poll = await heybox.pollQrLogin(qr.token);
    check('轮询返回明确状态', ['waiting', 'scanned', 'retry', 'expired'].includes(poll.state), poll.state);
    await sleep(500);
  }
  const bad = await heybox.pollQrLogin('not-a-real-token');
  check('无效 token 归为失效', bad.state === 'expired', bad.state);

  const prof = await heybox.getProfile();
  check('未登录资料查询优雅失败', prof.ok === false, prof.message);

  console.log(`\n== 结果：${failed === 0 ? '全部通过' : failed + ' 项失败'} ==`);
  process.exit(failed === 0 ? 0 : 1);
})();
