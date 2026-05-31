function toAshareFinanceCode(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error("Invalid A-share stock code.");
  }

  const shPrefixes = ["600", "601", "603", "605", "688", "689", "900"];
  return `${shPrefixes.some((prefix) => normalized.startsWith(prefix)) ? "SH" : "SZ"}${normalized}`;
}

async function loadAshareFinance(code) {
  const fullCode = toAshareFinanceCode(code);
  const apiUrl = `https://emweb.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?code=${encodeURIComponent(fullCode)}&type=0`;
  const upstream = await fetch(apiUrl, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: `https://emweb.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?code=${fullCode}&type=web`,
    },
  });

  if (!upstream.ok) {
    throw new Error(`Eastmoney HTTP ${upstream.status}`);
  }

  const payload = await upstream.json();
  const items = Array.isArray(payload?.data) ? payload.data.slice(0, 3) : [];
  if (!items.length) {
    throw new Error("Empty finance data.");
  }

  return {
    code: items[0].SECURITY_CODE || code,
    name: items[0].SECURITY_NAME_ABBR || code,
    reports: items.map((item) => ({
      reportDate: String(item.REPORT_DATE || "").slice(0, 10),
      reportName: item.REPORT_DATE_NAME || item.REPORT_TYPE || "",
      revenue: Number(item.TOTALOPERATEREVE),
      revenueGrowth: Number(item.TOTALOPERATEREVETZ),
      parentNetProfit: Number(item.PARENTNETPROFIT),
      parentNetProfitGrowth: Number(item.PARENTNETPROFITTZ),
      grossMargin: Number(item.XSMLL),
      netMargin: Number(item.XSJLL),
    })),
  };
}

export function createAshareFinanceHandler() {
  return async function ashareFinanceHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const code = requestUrl.searchParams.get("code") || "";
      const payload = await loadAshareFinance(code);
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
