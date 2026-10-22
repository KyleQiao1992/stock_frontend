export const TENCENT_KLINE_HOSTS = Object.freeze([
  'https://ifzq.gtimg.cn',
  'https://web.ifzq.gtimg.cn',
]);

/** Retry the same Tencent request on its available origins.
 * The caller owns the path, parameters, transport and payload validation.
 * A host becomes preferred only after the caller accepts its payload.
 */
export function createTencentKlineHostSelector(hosts = TENCENT_KLINE_HOSTS) {
  if (!Array.isArray(hosts) || !hosts.length || hosts.some(host => typeof host !== 'string' || !host.trim())) {
    throw new TypeError('腾讯行情需要至少一个有效域名');
  }
  const candidates = [...new Set(hosts)];
  let preferredHost = candidates[0];

  return async function select(loadCallback) {
    if (typeof loadCallback !== 'function') throw new TypeError('腾讯行情需要数据加载器');
    const ordered = [preferredHost, ...candidates.filter(host => host !== preferredHost)];
    const errors = [];
    for (const host of ordered) {
      try {
        const payload = await loadCallback(host);
        preferredHost = host;
        return payload;
      } catch (cause) {
        errors.push(new Error(`${host}: ${cause?.message || String(cause)}`, { cause }));
      }
    }
    throw new AggregateError(errors, `腾讯行情域名请求均失败：${errors.map(error => error.message).join('；')}`);
  };
}

export const requestTencentKlineHost = createTencentKlineHostSelector();
