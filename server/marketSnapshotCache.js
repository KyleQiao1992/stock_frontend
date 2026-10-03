const LAST_GOOD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_STAGES = new Set([
  "universe-count", "universe-page", "quotes", "industry-directory", "industry-page",
  "snapshot-validation", "quote-comparison", "industry-map", "market-capital",
]);
const DIAGNOSTIC_CODES = new Set([
  "PRIMARY_SNAPSHOT_INVALID", "FALLBACK_SNAPSHOT_INVALID", "FALLBACK_QUOTE_OLDER",
  "EASTMONEY_CLASSIFICATION_INVALID", "EASTMONEY_CLASSIFICATION_HTTP_ERROR",
  "EM_CAPITAL_INPUT_INVALID", "EM_CAPITAL_ABORTED", "EM_CAPITAL_TIMEOUT", "EM_CAPITAL_NETWORK_ERROR",
  "EM_CAPITAL_HTTP_ERROR", "EM_CAPITAL_RESPONSE_INVALID", "EM_CAPITAL_COVERAGE_INCOMPLETE", "EM_CAPITAL_CLOSE_MISMATCH",
  "SINA_HTTP_ERROR", "SINA_NETWORK_ERROR", "SINA_TIMEOUT", "SINA_RESPONSE_INVALID", "SINA_COVERAGE_INCOMPLETE",
  "TENCENT_HTTP_ERROR", "TENCENT_NETWORK_ERROR", "TENCENT_TIMEOUT", "TENCENT_RESPONSE_INVALID", "TENCENT_COVERAGE_INCOMPLETE",
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH", "UND_ERR_RES_EXCEEDED_MAX_SIZE", "UND_ERR_RESPONSE_STATUS_CODE",
  "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_NOT_YET_VALID", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function snapshotError(message, code, stage) {
  return Object.assign(new Error(message), {code, stage});
}

// Full snapshots keep their established keys. Incomplete provider fallbacks use
// a separate key so another deployed version cannot mistake them for full data.
export function createMarketSnapshotCache({ key, freshMs, staleMs, load, loadFallback = null, fallbackVersion = 2, validate, now = Date.now, onFull = null, emptyClosed, preferCompletePreviousSession = false }) {
  let fresh = null;
  let lastGood = null;
  let fallback = null;
  let inflight = null;
  let lastRefreshReason = null;
  let lastFailureAt = -Infinity;
  let activeProvider = null;
  const FAILURE_COOLDOWN_MS = 30000;
  const fallbackKey = `${key.replace(/:v\d+$/, "")}:v${fallbackVersion}:snapshot`;

  function entry(payload, cachedAt = null) {
    const at = Date.parse(payload?.updatedAt);
    if (!validate(payload) || !Number.isFinite(at) || at > now() || now() - at >= LAST_GOOD_MS) return null;
    if (payload.quoteTime != null) {
      const quoteAt = Date.parse(payload.quoteTime);
      if (!Number.isFinite(quoteAt) || quoteAt > now() || now() - quoteAt >= MAX_QUOTE_AGE_MS) return null;
    }
    for (const date of [payload.date, payload.dataDate].filter((value) => value != null)) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const start = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date
        || date > new Date(now() + 8 * 3600000).toISOString().slice(0, 10)) return null;
      const endOfShanghaiDay = start + 16 * 3600000 - 1;
      if (now() - endOfShanghaiDay >= MAX_QUOTE_AGE_MS) return null;
    }
    const fetchedAt = cachedAt == null ? at : Number(cachedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt > now()) return null;
    return {payload, at, cachedAt: fetchedAt};
  }

  const full = (candidate) => candidate && !candidate.payload.partial && candidate.payload.mode !== "snapshot";
  const usable = (candidate) => candidate && Boolean(entry(candidate.payload, candidate.cachedAt));
  const age = (candidate) => now() - candidate.cachedAt;
  const sameShanghaiDate = (candidate) => new Date(candidate.at + 8 * 3600000).toISOString().slice(0, 10)
    === new Date(now() + 8 * 3600000).toISOString().slice(0, 10);

  function quotePosition(candidate) {
    const payload = candidate?.payload;
    const ms = Date.parse(payload?.quoteTime);
    return {
      day: Number.isFinite(ms) ? new Date(ms + 8 * 3600000).toISOString().slice(0, 10) : payload?.dataDate || payload?.date || "",
      ms: Number.isFinite(ms) ? ms : null,
    };
  }

  function compareQuotes(left, right) {
    const a = quotePosition(left);
    const b = quotePosition(right);
    if (a.day !== b.day) return a.day > b.day ? 1 : -1;
    // A date-only dashboard cannot be ranked more precisely than its session.
    if (a.ms !== null && b.ms !== null) return Math.sign(a.ms - b.ms);
    return 0;
  }

  function preferCompletedSession(primary, backup) {
    if (!preferCompletePreviousSession || !full(primary) || !backup?.payload.partial) return false;
    const completeBreadth = primary.payload.breadth;
    const alternateBreadth = backup.payload.breadth;
    if (completeBreadth && alternateBreadth
      && ["up", "down", "flat", "total"].some((field) => completeBreadth[field] !== alternateBreadth[field])) return false;
    const complete = quotePosition(primary);
    const alternate = quotePosition(backup);
    if (complete.ms === null || complete.day !== alternate.day
      || primary.payload.date !== complete.day
      || primary.payload.dataDate != null && primary.payload.dataDate !== complete.day) return false;
    const currentDay = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    const quoteHour = new Date(complete.ms + 8 * 3600000).getUTCHours();
    // A vendor may update its closing quote timestamp after 15:00 without a
    // new session. Retain the complete close, but never an intraday snapshot.
    return currentDay > complete.day && quoteHour >= 15;
  }

  function bestAvailable(primary, backup) {
    if (!primary) return backup;
    if (!backup) return primary;
    if (preferCompletedSession(primary, backup)) return primary;
    const order = compareQuotes(backup, primary);
    if (order !== 0) return order > 0 ? backup : primary;
    if (activeProvider) return activeProvider === "fallback" ? backup : primary;
    // After restart, a recently fetched alternate may have superseded last-good;
    // a fresh complete primary still wins ties and preserves its classification.
    return sameShanghaiDate(backup) && age(backup) < freshMs
      && (!sameShanghaiDate(primary) || age(primary) >= freshMs) ? backup : primary;
  }

  async function available(redis) {
    return bestAvailable(await readLastGood(redis), await readFallback(redis));
  }

  async function read(redis, cacheKey) {
    if (!redis) return null;
    try {
      const raw = await redis.get(cacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function readFresh(redis) {
    if (usable(fresh)) return fresh;
    fresh = null;
    const payload = await read(redis, key);
    let cachedAt = null;
    if (redis && payload) {
      try { cachedAt = await redis.get(`${key}:ts`); } catch { /* Original payload time is still available. */ }
    }
    const candidate = entry(payload, cachedAt);
    if (full(candidate) && !candidate.payload.stale) {
      fresh = candidate;
      if (!lastGood || candidate.at > lastGood.at) lastGood = candidate;
    }
    return fresh;
  }

  async function readLastGood(redis) {
    if (usable(lastGood)) return lastGood;
    lastGood = null;
    const candidate = entry(await read(redis, `${key}:lastgood`));
    if (full(candidate) && !candidate.payload.stale) lastGood = candidate;
    return lastGood;
  }

  async function readFallback(redis) {
    if (usable(fallback)) return fallback;
    fallback = null;
    const candidate = entry(await read(redis, fallbackKey));
    if (candidate && !candidate.payload.stale) fallback = candidate;
    return fallback;
  }

  function stale(candidate, reason) {
    const payload = {...candidate.payload, stale: true, staleReason: reason};
    if (reason === "market-closed") {
      payload.marketClosed = true;
      payload.notice = "当前数据源未提供当日行情，正在显示最近一次有效快照，请留意数据截止时间。";
    } else if (reason === "upstream-error") {
      delete payload.marketClosed;
      payload.notice = "行情数据源暂时无法刷新，正在显示最近一次有效缓存，请留意数据截止时间。";
    } else {
      delete payload.marketClosed;
      payload.notice = "正在后台刷新行情，当前显示缓存数据，请留意数据截止时间。";
    }
    return payload;
  }

  async function persist(redis, candidate, isFull) {
    if (!redis) return;
    const body = JSON.stringify(candidate.payload);
    const writes = isFull
      ? [
        Promise.resolve().then(() => redis.set(key, body, {EX: Math.round(staleMs / 1000)})),
        Promise.resolve().then(() => redis.set(`${key}:ts`, String(candidate.cachedAt), {EX: Math.round(staleMs / 1000)})),
        Promise.resolve().then(() => redis.set(`${key}:lastgood`, body, {EX: LAST_GOOD_MS / 1000})),
      ]
      : [Promise.resolve().then(() => redis.set(fallbackKey, body, {EX: LAST_GOOD_MS / 1000}))];
    await Promise.allSettled(writes);
  }

  function unpack(result) {
    return result?.payload ? result : {payload: result, snapshot: null};
  }

  function logFailure(phase, error) {
    let cause = error;
    let code = "unknown";
    let stage = "unknown";
    let status = "unknown";
    let type = "upstream";
    for (let depth = 0; cause && depth < 5; depth += 1) {
      // Only enumerated metadata may reach logs. Never interpolate messages,
      // URLs, request headers, or arbitrary values carried by an upstream error.
      if (typeof cause.code === "string" && DIAGNOSTIC_CODES.has(cause.code)) code = cause.code;
      if (stage === "unknown" && typeof cause.stage === "string" && DIAGNOSTIC_STAGES.has(cause.stage)) stage = cause.stage;
      for (const value of [cause.status, cause.statusCode]) {
        if (status === "unknown" && Number.isInteger(value) && value >= 100 && value <= 599) status = value;
      }
      if (cause.name === "TypeError") type = "network";
      cause = cause.cause;
    }
    console.warn(`[${key}] ${phase} failed (type=${type}, code=${code}, stage=${stage}, status=${status})`);
  }

  async function refresh(redis, force = false) {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!force && now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
        const previous = await available(redis);
        if (previous) return stale(previous, lastRefreshReason || "upstream-error");
        if (lastRefreshReason === "market-closed") return emptyClosed(now());
        throw new Error("行情数据源暂不可用，请稍后重试。");
      }
      let reason = "upstream-error";
      try {
        const result = unpack(await load());
        if (result.payload?.live === false) reason = "market-closed";
        else {
          const candidate = entry(result.payload, now());
          if (!candidate || !full(candidate)) throw snapshotError("主行情快照的结构或时间异常", "PRIMARY_SNAPSHOT_INVALID", "snapshot-validation");
          fresh = candidate;
          lastGood = candidate;
          const previousBackup = await readFallback(redis);
          const keepBackup = previousBackup && compareQuotes(previousBackup, candidate) > 0
            && !preferCompletedSession(candidate, previousBackup);
          activeProvider = keepBackup ? "fallback" : "primary";
          lastRefreshReason = null;
          lastFailureAt = -Infinity;
          if (onFull && !keepBackup) { try { await onFull(result, redis); } catch { /* Full quote data remains valid. */ } }
          await persist(redis, candidate, true);
          if (keepBackup) {
            previousBackup.payload = {...previousBackup.payload, notice: "主数据源已恢复，但备用快照的行情时间较新，当前继续展示备用行情。"};
            return previousBackup.payload;
          }
          return candidate.payload;
        }
      } catch (error) {
        logFailure("primary", error);
        // Raw upstream diagnostics must not appear in public responses.
      }
      lastRefreshReason = reason;
      const previous = await readLastGood(redis);
      // A network failure must still probe the alternate even when last-good
      // exists. An explicit non-live response can retain the same-source close.
      if (reason === "market-closed" && previous) return stale(await available(redis), reason);
      const cachedBackup = await readFallback(redis);
      if (!force && cachedBackup && sameShanghaiDate(cachedBackup) && age(cachedBackup) < freshMs
        && (!previous || compareQuotes(cachedBackup, previous) >= 0)) {
        if (preferCompletedSession(previous, cachedBackup)) {
          activeProvider = "primary";
          return stale(previous, reason);
        }
        activeProvider = "fallback";
        return cachedBackup.payload;
      }
      if (loadFallback) {
        try {
          const result = unpack(await loadFallback({force}));
          // Version 3 providers must supply their entire declared contract;
          // adding a missing marker here could silently repair invalid data.
          const candidate = entry(fallbackVersion >= 3 ? result.payload : {...result.payload, partial: true}, now());
          if (!candidate) throw snapshotError("备用行情快照的结构或时间异常", "FALLBACK_SNAPSHOT_INVALID", "snapshot-validation");
          const best = bestAvailable(previous, cachedBackup);
          if (best && compareQuotes(candidate, best) < 0) throw snapshotError("备用行情时间早于已有快照", "FALLBACK_QUOTE_OLDER", "quote-comparison");
          fallback = candidate;
          const preferPrevious = preferCompletedSession(previous, candidate);
          activeProvider = preferPrevious ? "primary" : "fallback";
          if (onFull) { try { await onFull({...result, payload: candidate.payload}, redis); } catch { /* Aggregate fallback remains valid. */ } }
          await persist(redis, candidate, false);
          if (preferPrevious) return stale(previous, reason);
          return candidate.payload;
        } catch (error) { logFailure("fallback", error); }
      }
      const best = await available(redis);
      if (best) return stale(best, reason);
      if (reason === "market-closed") return emptyClosed(now());
      throw new Error("行情数据源暂不可用，且没有可用的历史快照，请稍后重试。");
    })().finally(() => {
      if (lastRefreshReason) lastFailureAt = now();
      inflight = null;
    });
    return inflight;
  }

  return {
    async get(redis, {retry = false} = {}) {
      const candidate = await readFresh(redis);
      if (!retry) {
        const prior = await available(redis);
        if (prior) {
          if (sameShanghaiDate(prior) && age(prior) < freshMs) return prior.payload;
          const reason = lastRefreshReason || "cache-expired";
          if (inflight || now() - lastFailureAt >= FAILURE_COOLDOWN_MS) refresh(redis).catch(() => {});
          return {...stale(prior, prior === candidate && age(prior) < staleMs && !lastRefreshReason ? "revalidating" : reason), refreshing: Boolean(inflight)};
        }
      }
      return refresh(redis, retry);
    },
    lastGood: readLastGood,
    lastFallback: readFallback,
  };
}
