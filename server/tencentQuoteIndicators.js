// HK/US layouts differ from A-shares. These volume-ratio positions were
// checked using Tencent snapshots and daily history (2026-10-03), including
// HK 00700/09988/00005 and US MSFT/AAPL/IBM. They are undocumented provider
// fields; preserve the original value, never substitute a local calculation.
export function parseTencentQuoteIndicators(fields, market) {
  const empty = { volumeRatio: null, volumeRatioSource: "unavailable",
    sessionVwap: null, sessionVwapPremium: null, sessionVwapSource: "unavailable",
    innerVol: null, outerVol: null, tradeSideVolumeSource: "unavailable",
    indicatorsQuoteTime: "" };
  const marker = market === "hk" ? "100" : market === "us" ? "200" : "";
  if (!marker || !Array.isArray(fields) || String(fields[0]) !== marker) return empty;
  const timestamp = String(fields[30] || "");
  if (!/^\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(timestamp)) return empty;
  const raw = fields[market === "hk" ? 50 : 64];
  const ratio = raw == null || String(raw).trim() === "" ? null : Number(raw);
  const volumeRatio = Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
  // HK/US snapshots give cumulative volume in shares and turnover in the
  // quoted currency. This is the session's actual turnover / volume, using
  // the same snapshot; no typical-price or historical-bar approximation.
  const positive = value => value != null && String(value).trim() !== ""
    && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const volume = positive(fields[36]);
  const turnover = positive(fields[37]);
  const price = positive(fields[3]);
  const average = volume && turnover ? turnover / volume : null;
  const sessionVwap = Number.isFinite(average) && average > 0 ? average : null;
  const sessionVwapPremium = sessionVwap && price ? (price / sessionVwap - 1) * 100 : null;
  // Slots 7/8 are zero-filled for the sampled HK/US feeds; do not present
  // those placeholders as actual trade-side volumes, even on a quiet day.
  return { ...empty, volumeRatio,
    sessionVwap, sessionVwapPremium,
    sessionVwapSource: sessionVwap === null ? "unavailable" : "tencent",
    volumeRatioSource: volumeRatio === null ? "unavailable" : "tencent",
    indicatorsQuoteTime: timestamp };
}
