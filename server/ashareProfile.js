function toAshareFinanceCode(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error("Invalid A-share stock code.");
  }

  const shPrefixes = ["600", "601", "603", "605", "688", "689", "900"];
  return `${shPrefixes.some((prefix) => normalized.startsWith(prefix)) ? "SH" : "SZ"}${normalized}`;
}

async function fetchEastmoneyJson(url, referer) {
  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: referer,
    },
  });

  if (!upstream.ok) {
    throw new Error(`Eastmoney HTTP ${upstream.status}`);
  }

  return await upstream.json();
}

function cleanHtmlText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values, limit = 12) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function parseTonghuashunConceptHtml(html) {
  const conceptDetails = [];
  const conceptPattern =
    /<tr>\s*<td>\s*\d+\s*<\/td>[\s\S]*?<td[^>]*class=["'][^"']*\bgnName\b[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<div[^>]*class=["'][^"']*\btdContent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/tr>\s*<tr[^>]*class=["'][^"']*\bextend_content\b[^"']*["'][^>]*>[\s\S]*?<td[^>]*colspan=["']4["'][^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match;

  while ((match = conceptPattern.exec(html)) && conceptDetails.length < 8) {
    const name = cleanHtmlText(match[1]);
    const detail = cleanHtmlText(match[3] || match[2]);
    if (!name) continue;
    conceptDetails.push({ name, detail });
  }

  const compareTags = [];
  const tagPattern = /\btag=["']([^"']+)["']/gi;
  while ((match = tagPattern.exec(html))) {
    compareTags.push(cleanHtmlText(match[1]));
  }

  return {
    concepts: uniqueStrings(
      [
        ...conceptDetails.map((item) => item.name),
        ...compareTags,
      ],
      16,
    ),
    details: conceptDetails,
  };
}

async function fetchTonghuashunConcepts(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error("Invalid A-share stock code.");
  }

  const upstream = await fetch(`https://basic.10jqka.com.cn/${normalized}/concept.html`, {
    headers: {
      Accept: "text/html,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: `https://basic.10jqka.com.cn/${normalized}/`,
    },
  });

  if (!upstream.ok) {
    throw new Error(`Tonghuashun HTTP ${upstream.status}`);
  }

  const html = new TextDecoder("gb18030").decode(await upstream.arrayBuffer());
  return parseTonghuashunConceptHtml(html);
}

async function loadAshareProfile(code) {
  const fullCode = toAshareFinanceCode(code);
  const baseReferer = "https://emweb.securities.eastmoney.com/";
  const [companyPayload, conceptPayload, businessPayload] = await Promise.all([
    fetchEastmoneyJson(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${encodeURIComponent(fullCode)}`,
      `${baseReferer}PC_HSF10/CompanySurvey/Index?code=${fullCode}`,
    ),
    fetchEastmoneyJson(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${encodeURIComponent(fullCode)}`,
      `${baseReferer}PC_HSF10/CoreConception/Index?code=${fullCode}`,
    ),
    fetchEastmoneyJson(
      `https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${encodeURIComponent(fullCode)}`,
      `${baseReferer}PC_HSF10/BusinessAnalysis/Index?code=${fullCode}`,
    ),
  ]);
  const tonghuashunResult = await fetchTonghuashunConcepts(code)
    .then((payload) => ({ ok: true, payload }))
    .catch((error) => ({ ok: false, error: error?.message || String(error) }));

  const company = Array.isArray(companyPayload?.jbzl) ? companyPayload.jbzl[0] : null;
  const business = Array.isArray(businessPayload?.zyfw) ? businessPayload.zyfw[0] : null;
  const review = Array.isArray(businessPayload?.jyps) ? businessPayload.jyps[0] : null;
  const boardItems = Array.isArray(conceptPayload?.ssbk) ? conceptPayload.ssbk : [];
  const preciseConcepts = uniqueStrings(
    boardItems
      .filter((item) => String(item?.IS_PRECISE || "") === "1")
      .map((item) => item?.BOARD_NAME),
    16,
  );
  const boards = uniqueStrings(boardItems.map((item) => item?.BOARD_NAME), 12);
  const supplementalBoards = boards.filter((item) => !preciseConcepts.includes(item)).slice(0, 8);
  const highlights = Array.isArray(conceptPayload?.hxtc)
    ? conceptPayload.hxtc
        .map((item) => ({
          keyword: String(item?.KEYWORD || "").trim(),
          title: String(item?.MAINPOINT || "").trim(),
          content: String(item?.MAINPOINT_CONTENT || "").replace(/\s+/g, " ").trim(),
        }))
        .filter((item) => item.keyword || item.title || item.content)
        .slice(0, 3)
    : [];

  return {
    code: company?.SECURITY_CODE || code,
    name: company?.SECURITY_NAME_ABBR || code,
    company: {
      orgName: String(company?.ORG_NAME || "").trim(),
      industry: String(company?.EM2016 || company?.INDUSTRYCSRC1 || "").trim(),
      market: String(company?.TRADE_MARKET || "").trim(),
      website: String(company?.ORG_WEB || "").trim(),
      businessScope: String(business?.BUSINESS_SCOPE || "").replace(/\s+/g, " ").trim(),
      businessReview: String(review?.BUSINESS_REVIEW || "").replace(/\s+/g, " ").trim(),
    },
    themes: {
      boards,
      preciseConcepts,
      supplementalBoards,
      highlights,
      sources: [
        {
          key: "eastmoney",
          name: "东方财富 F10",
          status: "ok",
          concepts: preciseConcepts.length ? preciseConcepts : boards,
          supplemental: supplementalBoards,
          highlights,
        },
        {
          key: "tonghuashun",
          name: "同花顺 F10",
          status: tonghuashunResult.ok ? "ok" : "error",
          concepts: tonghuashunResult.ok ? tonghuashunResult.payload.concepts : [],
          details: tonghuashunResult.ok ? tonghuashunResult.payload.details : [],
          error: tonghuashunResult.ok ? null : tonghuashunResult.error,
        },
      ],
    },
  };
}

export function createAshareProfileHandler() {
  return async function ashareProfileHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const code = requestUrl.searchParams.get("code") || "";
      const payload = await loadAshareProfile(code);
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
