export const TDX_HISTORY_SOURCE = Object.freeze({ key: "tdx", name: "通达信历史分笔统计" });

// These checks establish consistency with the daily bar. They do not establish
// that the vendor's buy/sell labels match exchange transaction flags.
export function tdxHistoryVerification() {
  return {
    directionSource: "tdx",
    exchangeDirectionVerified: false,
    rawRecordsRetained: false,
    comparisonSource: "tencent-unadjusted-daily",
    validationScope: ["pagination", "regular-volume", "regular-close"],
  };
}
