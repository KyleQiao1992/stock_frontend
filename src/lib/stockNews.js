export const NEWS_CATEGORIES = [
  { key: 'news', label: '新闻', type: 2 },
  { key: 'notice', label: '公告', type: 0 },
  { key: 'report', label: '研报', type: 1 },
];
export function newsSymbol(code, market = 'ashare') {
  if (market === 'hk') {
    if (!/^\d{5}$/.test(code)) throw new Error('请先选择一只港股');
    return `hk${code}`;
  }
  if (!/^\d{6}$/.test(code)) throw new Error('请先选择一只 A 股');
  return `${code.startsWith('6') ? 'sh' : /^[489]/.test(code) ? 'bj' : 'sz'}${code}`;
}
export function parseNews(payload) {
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.data)) throw new Error('资讯接口返回异常，请稍后重试');
  const seen = new Set();
  return payload.data.data.flatMap((row) => {
    const title = String(row.title || '').trim();
    if (!title) return [];
    let url = '';
    try { const parsed = new URL(row.url); if (['https:', 'http:'].includes(parsed.protocol)) url = parsed.href; } catch { /* Missing links remain plain text. */ }
    const key = String(row.id || `${title}:${row.time || row.create_time || ''}`);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, title, url, source: String(row.src || '').trim(), time: String(row.time || row.create_time || '').slice(0, 16) }];
  });
}
export function createNewsLoader(request = fetch) {
  const cache = new Map();
  const pending = new Map();
  return async function load(code, category, refresh = false, market = 'ashare') {
    const symbol = newsSymbol(code, market);
    const cat = NEWS_CATEGORIES.find((c) => c.key === category);
    if (!cat) throw new Error('资讯分类无效');
    const key = `${symbol}:${category}`;
    const hit = cache.get(key);
    if (!refresh && hit?.expires > Date.now()) return hit.items;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const response = await request(`https://proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search?symbol=${symbol}&n=20&page=1&type=${cat.type}`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!response.ok) throw new Error(`资讯接口 HTTP ${response.status}`);
      const items = parseNews(await response.json());
      if (cache.size >= 120) cache.delete(cache.keys().next().value);
      cache.set(key, { items, expires: Date.now() + 5 * 60000 });
      return items;
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  };
}
export const loadStockNews = createNewsLoader();
