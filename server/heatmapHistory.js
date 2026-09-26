import { createThsProvider } from './heatmapThs.js';
import { EM_UT, EM_FETCH_HEADERS, mapWithConcurrency } from './boardTrend.js';

const DAY = 86400000;
const CURRENT_QUERY_TTL = 5 * 60 * 1000;
const LIST_HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];
const HIST_HOSTS = ['https://push2his.eastmoney.com', 'https://79.push2his.eastmoney.com'];
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const number = (v) => v == null || v === '' || v === '-' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

export function validateHistoryQuery(params) {
  const start = params.get('start') || '';
  const end = params.get('end') || start;
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(start) || !valid(end) || start > end) throw new Error('请选择有效的起止日期');
  if (end > today()) throw new Error('结束日期不能晚于北京时间今天');
  if ((Date.parse(end) - Date.parse(start)) / DAY > 366) throw new Error('单次区间最多366天');
  const board = params.get('board') || '';
  if (board && !/^BK\d{4,6}$/.test(board)) throw new Error('行业代码无效');
  return { start, end, board };
}

export function summarizeHistory(lines, start, end) {
  const byDate = new Map();
  for (const line of lines) {
    const p = String(line).split(',');
    if (/^\d{4}-\d{2}-\d{2}$/.test(p[0])) byDate.set(p[0], { date: p[0], close: number(p[2]), amount: number(p[6]), pct: number(p[8]) });
  }
  const selected = [...byDate.values()].filter((b) => b.date >= start && b.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  if (!selected.length) return null;
  if (selected.some((b) => b.close == null || b.close <= 0 || b.amount == null || b.pct == null)) throw new Error('历史字段不完整');
  // First-day pct supplies its prior close; later prices share the same adjustment basis.
  const first = selected[0];
  const base = first.close / (1 + first.pct / 100);
  if (!(base > 0 && Number.isFinite(base))) throw new Error('历史基准价无效');
  return {
    pct: Math.round((selected.at(-1).close / base - 1) * 10000) / 100,
    amount: selected.reduce((sum, b) => sum + b.amount, 0) / 1e8,
    firstDate: first.date, lastDate: selected.at(-1).date, days: selected.length,
    historical: true, stocks: [],
  };
}

async function getJson(url) {
  const r = await fetch(url, { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`行情接口 HTTP ${r.status}`);
  const payload = await r.json();
  if (!payload.data) throw new Error('行情接口未返回有效数据');
  return payload.data;
}

// Separate history path: no Redis or database calls. Bounded cache and one shared job.
export function createHistoryService(request = getJson, provider = null) {
  const cache = new Map();
  const jobs = new Map();
  let active = null;
  function remember(key, value, ttl = 6 * 3600000) {
    if (cache.size >= 1200) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + ttl });
    return value;
  }
  async function cached(key, load, ttl) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    return remember(key, await load(), ttl);
  }
  async function fallback(hosts, path, accept) {
    let error;
    for (const host of hosts) {
      try { const result = await request(host + path); if (accept(result)) return result; throw new Error('历史行情源返回空数据'); }
      catch (e) { error = e; }
    }
    throw error;
  }
  async function listing(board) {
    return cached(`list:${board}`, async () => {
      if (provider) return provider.listing(board);
      const fs = board ? `b:${board}` : 'm:90+t:2+f:!50';
      const path = (page) => `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&fid=f12&fs=${fs}&fields=f12,f13,f14&ut=${EM_UT}`;
      const first = await fallback(LIST_HOSTS, path(1), (d) => Array.isArray(d.diff) && d.diff.length);
      const pages = Math.ceil(first.total / 100);
      if (pages > 30) throw new Error('行情列表规模异常');
      const rest = await mapWithConcurrency(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 3,
        (page) => fallback(LIST_HOSTS, path(page), (d) => Array.isArray(d.diff) && d.diff.length));
      const rows = [...new Map([first, ...rest].flatMap((p) => p.diff).map((r) => [r.f12, r])).values()];
      if (rows.length < first.total) throw new Error('行业或成分股列表不完整，请重试');
      return rows.map((r) => ({ code: r.f12, name: r.f14, market: r.f13 }));
    }, 3600000);
  }
  async function bars(item, query) {
    if (provider) return provider.bars(item, query);
    // Calendar-year blocks allow nearby date selections to reuse fetched history.
    const year = query.start.slice(0, 4);
    const lastYear = query.end.slice(0, 4);
    const secid = `${query.board ? item.market : 90}.${item.code}`;
    return cached(`bars:${secid}:${year}:${lastYear}`, async () => {
      const path = `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=${query.board ? 1 : 0}&beg=${year}0101&end=${lastYear}1231&lmt=1000&ut=${EM_UT}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
      const data = await fallback(HIST_HOSTS, path, (d) => Array.isArray(d.klines) && d.klines.length);
      return data.klines;
    }, lastYear >= today().slice(0, 4) ? 60000 : 6 * 3600000);
  }
  async function run(job, query) {
    try {
      const list = await listing(query.board);
      job.total = list.length;
      const deadline = Date.now() + 90000;
      async function one(item) {
        try {
          if (Date.now() >= deadline) throw new Error('达到本次加载时限');
          const result = summarizeHistory(await bars(item, query), query.start, query.end);
          if (result) job.rows.push({ ...item, ...result }); else job.empty++;
        } catch (e) { job.failed.push(item.name); job.failureReasons[item.name] = e.cause?.code || e.message; }
        job.done++;
      }
      // Probe first, so unavailable hosts do not trigger hundreds of doomed requests.
      await mapWithConcurrency(list.slice(0, 3), 3, one);
      if (job.failed.length === Math.min(3, list.length) && list.length) {
        job.error = '历史行情接口当前不可用，请稍后重试；未使用最新行情替代历史数据。';
      } else {
        // 同花顺每个行业是独立的静态年度日线文件，可安全提高并发；
        // 东方财富兜底接口仍维持较低并发，避免触发实时行情源限流。
        await mapWithConcurrency(list.slice(3), provider ? 16 : 6, one);
      }
    } catch (e) { job.error = e.message; }
    finally { job.status = 'complete'; job.finishedAt = Date.now(); active = null; }
  }
  return {
    query(query, retry = false) {
      const key = JSON.stringify(query);
      let job = jobs.get(key);
      if (job && job.status === 'complete' && ((retry && (job.error || job.failed.length)) || Date.now() - job.finishedAt > (query.end >= today() ? CURRENT_QUERY_TTL : 10 * 60000))) { jobs.delete(key); job = null; }
      if (!job) {
        if (active) return { status: 'busy', notice: '另一个历史查询正在加载，请稍后重试。' };
        if (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
        job = { status: 'loading', done: 0, total: 0, rows: [], failed: [], failureReasons: {}, empty: 0 };
        jobs.set(key, job); active = job;
        void run(job, query);
      }
      const { rows, ...state } = job;
      return { historical: true, start: query.start, end: query.end, ...state,
        industries: query.board ? [] : rows, stocks: query.board ? rows : [],
        partial: job.failed.length > 0, source: provider?.source || '东方财富历史日线', supportsDrilldown: provider?.supportsDrilldown ?? true,
      };
    },
  };
}

const service = createHistoryService(undefined, createThsProvider());
export function handleHeatmapHistory(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  if (!params.has('start')) return false;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { res.end(JSON.stringify(service.query(validateHistoryQuery(params), params.get('retry') === '1'))); }
  catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
  return true;
}
