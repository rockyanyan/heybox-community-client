// 实测二维码登录接口
const { signUrl } = require('../src/hkey');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

async function get(pathAndQuery) {
  const url = signUrl('https://api.xiaoheihe.cn' + pathAndQuery);
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA, Referer: 'https://xiaoheihe.cn/' },
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, json: await res.json().catch(() => null), setCookie };
}

(async () => {
  // 最小参数集（对齐 heybox-cli）
  const q1 = '/account/get_qrcode_url/?app=web&os_type=web&version=999.0.3&x_app=heybox_website&x_client_type=web&x_os_type=Windows';
  const r1 = await get(q1);
  console.log('[A 创建二维码 · 最小参数] HTTP', r1.status, 'status=', r1.json?.status);
  console.log('   result:', JSON.stringify(r1.json?.result).slice(0, 300));
  console.log('   set-cookie:', r1.setCookie.length ? r1.setCookie.map((c) => c.split(';')[0]).join(' | ') : '(无)');

  // 带完整公共参数
  const q2 = '/account/get_qrcode_url/?app=web&os_type=web&app=heybox&client_type=web&version=999.0.4&web_version=2.5&x_app=heybox_website&x_client_type=web&x_os_type=Windows&device_info=Chrome&device_id=2c2fef8385ccef915e3b3caf94e3aa06&heybox_id=0';
  const r2 = await get(q2);
  console.log('\n[B 创建二维码 · 完整参数] HTTP', r2.status, 'status=', r2.json?.status);
  console.log('   result:', JSON.stringify(r2.json?.result).slice(0, 300));

  // 用 B 的 qr token 轮询
  const qrUrl = r2.json?.result?.qr_url;
  if (qrUrl) {
    const token = new URL(qrUrl).searchParams.get('qr');
    console.log('\n   qr token =', token);
    console.log('   二维码内容 =', qrUrl);
    for (let i = 0; i < 3; i++) {
      const r3 = await get(
        `/account/qr_state/?app=web&qr=${encodeURIComponent(token)}&os_type=web&app=heybox&client_type=web&version=999.0.4&web_version=2.5&x_app=heybox_website&x_client_type=web&x_os_type=Windows&device_info=Chrome&device_id=2c2fef8385ccef915e3b3caf94e3aa06&heybox_id=0`
      );
      console.log(`[C 轮询 ${i + 1}] HTTP`, r3.status, 'status=', r3.json?.status, 'result=', JSON.stringify(r3.json?.result).slice(0, 200));
      console.log('   set-cookie:', r3.setCookie.length ? r3.setCookie.map((c) => c.split(';')[0]).join(' | ') : '(无)');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();
