// 用真实接口验证 src/heybox.js 的数据链路
const heybox = require('../src/heybox');

const strip = (s, n = 60) => String(s || '').slice(0, n);

(async () => {
  console.log('== 配置 ==', heybox.getState());

  const cat = await heybox.getCategories();
  console.log('\n[分类] ok=%s status=%s', cat.ok, cat.status);
  const hot = cat.result?.latest_hot_topics?.children || [];
  console.log('  热门社区数:', hot.length, '| 前3:', hot.slice(0, 3).map((t) => t.name).join(' / '));

  const feed = await heybox.getFeeds(0, 5, 1);
  console.log('\n[推荐流] ok=%s status=%s 条数=%s', feed.ok, feed.status, feed.result?.links?.length);
  (feed.result?.links || []).slice(0, 3).forEach((l, i) => {
    console.log(`  ${i + 1}. ${strip(l.title, 26)} | 作者=${l.user?.username} Lv.${l.user?.level_info?.level} | 赞=${l.link_award_num} 评=${l.comment_num} 图=${l.imgs?.length || 0} | ${l.create_at}`);
  });

  const t0 = hot[0];
  if (t0) {
    const tf = await heybox.getTopicFeeds(t0.topic_id, 0, 3, 0);
    console.log('\n[板块 %s] ok=%s 条数=%s', t0.name, tf.ok, tf.result?.links?.length);
    (tf.result?.links || []).slice(0, 2).forEach((l) => console.log('  -', strip(l.title, 30)));
  }

  const det = await heybox.getLinkTree(feed.result?.links?.[0]?.linkid, 0, 5);
  console.log('\n[详情] ok=%s status=%s needLogin=%s', det.ok, det.status, det.needLogin);

  const se = await heybox.search('塞尔达', 0, 3);
  console.log('[搜索] ok=%s status=%s needLogin=%s', se.ok, se.status, se.needLogin);

  // 图片代理白名单自检
  const { signUrl, getHkey } = require('../src/hkey');
  const good = new URL(signUrl('https://api.xiaoheihe.cn/bbs/app/feeds?a=1')).searchParams;
  console.log('\n[签名] hkey=%s _time=%s nonce长度=%s', good.get('hkey'), good.get('_time'), good.get('nonce').length);
  console.log('  已知向量校验:', getHkey('/account/data_report_web/', 1770529394, '3D6891C5FEBD5A0A4C986784D2F60E81') === '3XX1P62' ? 'PASS' : 'FAIL');
})();
