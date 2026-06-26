// 美股「公司基本介绍 + 主营构成/机构评级」数据源。
// 全部取自东方财富 datacenter 美股 F10（datacenter.eastmoney.com），返回中文字段，
// 与 A 股 F10 同属东财体系，国内服务器可达性与 server/ashareProfile.js 一致。
// 美股没有 A 股那套「概念板块/炒作题材」标签，第二块改用：行业 + 主营构成(产品占比) + 机构评级共识。

const DATACENTER_BASE = "https://datacenter.eastmoney.com/securities/api/data/v1/get";

function normalizeUsSymbol(symbol) {
  const normalized = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(normalized)) {
    throw new Error("Invalid US stock symbol.");
  }
  return normalized;
}

// 东财 SECURITY_CODE 里带点/带杠的代码用下划线，例如 BRK.B -> BRK_B。
function toEastmoneySecurityCode(normalized) {
  return normalized.replace(/[.-]/g, "_");
}

async function fetchDatacenter(reportName, securityCode, { columns = "ALL", pageSize = 1, sort } = {}) {
  const params = new URLSearchParams({
    reportName,
    columns,
    filter: `(SECURITY_CODE="${securityCode}")`,
    pageNumber: "1",
    pageSize: String(pageSize),
    source: "F10",
    client: "PC",
  });
  if (sort?.col) {
    params.set("sortColumns", sort.col);
    params.set("sortTypes", String(sort.type ?? -1));
  }

  const res = await fetch(`${DATACENTER_BASE}?${params.toString()}`, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: "https://emweb.securities.eastmoney.com/",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Eastmoney datacenter HTTP ${res.status}`);

  const payload = await res.json();
  return Array.isArray(payload?.result?.data) ? payload.result.data : [];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shortenOrgName(value) {
  return cleanText(value).replace(/股份有限公司$|有限公司$/u, "");
}

function buildProductSource(productRows) {
  if (!productRows.length) return null;
  const latestDate = productRows[0]?.REPORT_DATE;
  const latest = productRows.filter(
    (row) => row.REPORT_DATE === latestDate && String(row.IS_TOTAL) !== "1",
  );
  if (!latest.length) return null;

  const concepts = latest
    .map((row) => {
      const name = cleanText(row.PRODUCT_NAME);
      if (!name) return "";
      const ratio = Number(row.MBI_RATIO);
      return Number.isFinite(ratio) ? `${name} ${(ratio * 100).toFixed(1)}%` : name;
    })
    .filter(Boolean);
  if (!concepts.length) return null;

  const reportName = cleanText(latest[0]?.REPORT_NAME);
  return {
    key: "product",
    name: "主营构成",
    status: "ok",
    concepts,
    supplemental: reportName ? [`数据期：${reportName}`] : [],
  };
}

function buildRatingSource(ratingRows) {
  if (!ratingRows.length) {
    return { key: "rating", name: "机构评级", status: "ok", concepts: [], highlights: [], details: [] };
  }

  const consensus = cleanText(ratingRows[0]?.RATINGAVG);
  const targets = ratingRows
    .map((row) => Number(row.TARGET_PRICE))
    .filter((value) => Number.isFinite(value) && value > 0);

  let targetText = "";
  if (targets.length) {
    const avg = targets.reduce((sum, value) => sum + value, 0) / targets.length;
    const min = Math.min(...targets);
    const max = Math.max(...targets);
    targetText =
      min === max
        ? `目标价 $${avg.toFixed(2)}`
        : `目标价均值 $${avg.toFixed(2)}（区间 $${min.toFixed(2)}–$${max.toFixed(2)}）`;
  }

  const highlights = [
    {
      keyword: consensus ? `评级共识：${consensus}` : "机构评级",
      title: `近 ${ratingRows.length} 条评级`,
      content: targetText || "暂无目标价数据。",
    },
  ];

  const details = ratingRows.slice(0, 4).map((row) => {
    const org = shortenOrgName(row.ORG_NAME);
    const rating = cleanText(row.RATING_NAME);
    const date = String(row.PUBLISH_DATE || "").slice(0, 10);
    const target = Number(row.TARGET_PRICE);
    const targetPart = Number.isFinite(target) && target > 0 ? ` · 目标价 $${target}` : "";
    return {
      name: [org, rating].filter(Boolean).join(" · "),
      detail: [date, targetPart && targetPart.replace(/^ · /, "")].filter(Boolean).join(" · "),
    };
  });

  return { key: "rating", name: "机构评级", status: "ok", concepts: [], highlights, details };
}

async function loadUsProfile(symbol) {
  const normalized = normalizeUsSymbol(symbol);
  const securityCode = toEastmoneySecurityCode(normalized);

  const [profileRows, productRows, ratingRows] = await Promise.all([
    fetchDatacenter("RPT_USF10_INFO_ORGPROFILE", securityCode, { pageSize: 1 }),
    fetchDatacenter("RPT_USF10_INFO_PRODUCTSTRUCTURE", securityCode, {
      columns: "REPORT_DATE,REPORT_NAME,PRODUCT_NAME,MBI_RATIO,IS_TOTAL",
      pageSize: 30,
      sort: { col: "REPORT_DATE", type: -1 },
    }).catch(() => []),
    fetchDatacenter("RPT_USF10_INFO_ORGRATING", securityCode, {
      columns: "ORG_NAME,RATING_NAME,TARGET_PRICE,PUBLISH_DATE,RATINGORGNUM,RATINGAVG",
      pageSize: 12,
      sort: { col: "PUBLISH_DATE", type: -1 },
    }).catch(() => []),
  ]);

  const profile = profileRows[0];
  if (!profile) {
    throw new Error(`未找到 ${normalized} 的美股资料（东财 F10）。`);
  }

  const industry = cleanText(profile.BELONG_INDUSTRY);

  const productSource = buildProductSource(productRows);
  const ratingSource = buildRatingSource(ratingRows);
  // 把行业当作第一个标签，挂在主营构成（没有则单独成块）。
  if (industry) {
    if (productSource) {
      productSource.concepts = [industry, ...productSource.concepts];
    }
  }

  const sources = [];
  if (productSource) {
    sources.push(productSource);
  } else if (industry) {
    sources.push({ key: "industry", name: "行业", status: "ok", concepts: [industry] });
  }
  sources.push(ratingSource);

  return {
    code: cleanText(profile.SECURITY_CODE) || normalized,
    name: cleanText(profile.SECURITY_NAME_ABBR) || normalized,
    company: {
      orgName: cleanText(profile.ORG_NAME),
      orgEnName: cleanText(profile.ORG_EN_ABBR),
      industry,
      market: cleanText(profile.BELONG_MARKET),
      website: cleanText(profile.ORG_WEB),
      foundDate: String(profile.FOUND_DATE || "").slice(0, 10),
      employees: Number.isFinite(Number(profile.EMP_NUM)) ? Number(profile.EMP_NUM) : null,
      businessScope: cleanText(profile.ORG_PROFILE),
      businessReview: "",
    },
    themes: { sources },
  };
}

export function createUsProfileHandler() {
  return async function usProfileHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const symbol = requestUrl.searchParams.get("symbol") || requestUrl.searchParams.get("code") || "";
      const payload = await loadUsProfile(symbol);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || String(error) }));
    }
  };
}
