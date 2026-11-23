'use strict';
/**
 * 小黑盒 Web 端请求签名（hkey / _time / nonce）
 *
 * 该算法通过对 路径 + 时间戳 + nonce 做字符集映射、交错混合后取 MD5，
 * 再由 MD5 前 5 位映射出 hkey 前缀、后 6 位经 Rijndael 变换求和得到 2 位校验码。
 * 仅使用 Node 内置 crypto，无第三方依赖。
 *
 * 已知测试向量（回归用）：
 *   /account/data_report_web/ + 1770529394 + 3D6891C5FEBD5A0A4C986784D2F60E81 -> 3XX1P62
 *
 * 服务端对 _time 有 ±5 秒以上的容忍度（实测 now-5 ~ now+5 均通过），
 * 因此本地时钟轻微偏差不会导致签名失败。
 */

const { createHash } = require('node:crypto');

const CHARSET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'; // 36 位字符集

const Vm = (e) => (e & 128 ? 255 & ((e << 1) ^ 27) : e << 1);
const qm = (e) => Vm(e) ^ e;
const dm = (e) => qm(Vm(e));
const Ym = (e) => dm(qm(Vm(e)));
const Gm = (e) => Ym(e) ^ dm(e) ^ qm(e);

/** Rijndael 风格列混合：改写前 4 字节，其余字节原样保留 */
function Km(eArr) {
  const e = eArr.slice();
  const t0 = Gm(e[0]) ^ Ym(e[1]) ^ dm(e[2]) ^ qm(e[3]);
  const t1 = qm(e[0]) ^ Gm(e[1]) ^ Ym(e[2]) ^ dm(e[3]);
  const t2 = dm(e[0]) ^ qm(e[1]) ^ Gm(e[2]) ^ Ym(e[3]);
  const t3 = Ym(e[0]) ^ dm(e[1]) ^ qm(e[2]) ^ Gm(e[3]);
  e[0] = t0; e[1] = t1; e[2] = t2; e[3] = t3;
  return e;
}

/** 按字符集切片做映射；n<0 表示切掉末尾 |n| 位 */
function av(str, n) {
  const i = CHARSET.slice(0, n);
  let r = '';
  for (const ch of str) r += i[ch.charCodeAt(0) % i.length];
  return r;
}

/** 按完整字符集做映射 */
function sv(str) {
  let r = '';
  for (const ch of str) r += CHARSET[ch.charCodeAt(0) % CHARSET.length];
  return r;
}

/** 归一化路径：/a/b -> /a/b/ */
function normalizePath(pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  return '/' + parts.join('/') + '/';
}

/**
 * 计算 hkey
 * @param {string} pathname  请求路径，如 /bbs/app/feeds
 * @param {number} timestamp 秒级时间戳
 * @param {string} nonce     随机字符串（32 位十六进制大写）
 * @returns {string} 形如 "3XX1P62"
 */
function getHkey(pathname, timestamp, nonce) {
  const normalized = normalizePath(pathname);
  const comp1 = av(String(timestamp), -2); // 时间戳用前 34 位字符集
  const comp2 = sv(normalized);            // 路径用完整字符集
  const comp3 = sv(nonce);                 // nonce 用完整字符集

  const comps = [comp1, comp2, comp3];
  const maxLen = Math.max(comp1.length, comp2.length, comp3.length);
  let interleaved = '';
  for (let k = 0; k < maxLen; k++) {
    for (const c of comps) if (k < c.length) interleaved += c[k];
  }

  const md5 = createHash('md5').update(interleaved.slice(0, 20), 'utf8').digest('hex');
  const prefix = av(md5.slice(0, 5), -4); // MD5 前 5 位用前 32 位字符集
  const tail = md5.slice(-6).split('').map((c) => c.charCodeAt(0));
  // 前 4 字节列混合后，连同尾部未参与混合的 2 字节一起求和（Km 返回全部 6 字节）
  const checksum = Km(tail).reduce((a, b) => a + b, 0) % 100;

  return prefix + String(checksum).padStart(2, '0');
}

/** 生成 32 位随机 nonce（大写十六进制） */
function randomNonce() {
  return createHash('md5').update(String(Math.random()) + Date.now()).digest('hex').toUpperCase();
}

/** 生成 32 位随机设备号 */
function randomDeviceId() {
  let s = '';
  while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 32);
}

/**
 * 给 URL 附加签名参数
 * @param {string|URL} inputUrl
 * @param {{timestamp?:number, nonce?:string}} [opts]
 * @returns {string}
 */
function signUrl(inputUrl, opts = {}) {
  const u = inputUrl instanceof URL ? new URL(inputUrl.toString()) : new URL(inputUrl);
  const timestamp = opts.timestamp || Math.floor(Date.now() / 1000);
  const nonce = opts.nonce || randomNonce();
  u.searchParams.set('hkey', getHkey(u.pathname, timestamp, nonce));
  u.searchParams.set('_time', String(timestamp));
  u.searchParams.set('nonce', nonce);
  return u.toString();
}

module.exports = { getHkey, signUrl, randomNonce, randomDeviceId, normalizePath, CHARSET };
