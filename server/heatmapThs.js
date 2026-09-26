// Public industry directory and annual daily bars; no database dependency.
const DIRECTORY = 'https://q.10jqka.com.cn/thshy/detail/code/881272/';
const CURRENT_YEAR_TTL = 10 * 60 * 1000;
async function readText(url, encoding = 'utf-8') {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`同花顺历史接口 HTTP ${response.status}`);
  return new TextDecoder(encoding).decode(await response.arrayBuffer());
}
export function parseIndustryDirectory(html) {
  const rows = [...html.matchAll(/href="https?:\/\/q\.10jqka\.com\.cn\/thshy\/detail\/code\/(\d{6})\/"[^>]*>([^<]+)<\/a>/g)];
  const industries = [...new Map(rows.map((r) => [r[1], { code: `THS${r[1]}`, name: r[2].trim() }])).values()];
  if (!industries.length) throw new Error('同花顺行业目录未返回有效数据');
  return industries;
}
export function parseAnnualBars(text) {
  // Parse JSON inside JSONP without executing upstream JavaScript.
  const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (typeof payload.data !== 'string' || !payload.data) throw new Error('同花顺历史日线为空');
  return payload.data.split(';').filter(Boolean).map((line) => {
    const p = line.split(',');
    if (!/^\d{8}$/.test(p[0]) || !p[4] || !p[6] || !Number.isFinite(Number(p[4])) || Number(p[4]) <= 0 || !Number.isFinite(Number(p[6])) || Number(p[6]) < 0) throw new Error('同花顺历史字段不完整');
    return { date: `${p[0].slice(0,4)}-${p[0].slice(4,6)}-${p[0].slice(6,8)}`, close: Number(p[4]), amount: Number(p[6]) };
  });
}
export function toHistoryLines(rows) {
  const sorted = [...new Map(rows.map((r) => [r.date, r])).values()].sort((a,b) => a.date.localeCompare(b.date));
  return sorted.map((row,i) => `${row.date},0,${row.close},0,0,0,${row.amount},0,${i ? (row.close / sorted[i-1].close - 1) * 100 : '-'},0,0`);
}
export function createThsProvider(read = readText) {
  const years = new Map();
  async function annual(code, year) {
    const key = `${code}:${year}`;
    const hit = years.get(key);
    if (hit?.expires > Date.now()) return hit.rows;
    const rows = parseAnnualBars(await read(`https://d.10jqka.com.cn/v4/line/bk_${code}/01/${year}.js`));
    if (years.size >= 600) years.delete(years.keys().next().value);
    // 这是日线年度文件，不需要按分钟重复抓取 90 个行业；当前年份保留 10 分钟，
    // 历史年份仍保留 6 小时。查询结果层会更早更新，兼顾收盘后的新数据。
    years.set(key, { rows, expires: Date.now() + (year >= new Date().getUTCFullYear() ? CURRENT_YEAR_TTL : 6*3600000) });
    return rows;
  }
  return {
    source: '同花顺行业历史日线', supportsDrilldown: false,
    async listing(board) {
      if (board) throw new Error('当前历史数据源暂不支持成分股下钻');
      return parseIndustryDirectory(await read(DIRECTORY, 'gb18030'));
    },
    async bars(item, query) {
      const code = item.code.slice(3);
      const rows = [];
      for (let year = Number(query.start.slice(0,4)); year <= Number(query.end.slice(0,4)); year++) rows.push(...await annual(code, year));
      // Only January selections usually need a prior-year close for their baseline.
      if (rows.some((r) => r.date >= query.start && r.date <= query.end) && !rows.some((r) => r.date < query.start)) {
        rows.push(...await annual(code, Number(query.start.slice(0,4)) - 1));
      }
      return toHistoryLines(rows);
    },
  };
}
