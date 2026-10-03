const LAST_GOOD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Full snapshots keep their established keys. Incomplete provider fallbacks use
// a separate key so another deployed version cannot mistake them for full data.
export function createMarketSnapshotCache({ key, freshMs, staleMs, load, loadFallback = null, validate, now = Date.now, onFull = null, emptyClosed }) {
  let fresh = null;
  let lastGood = null;
  let fallback = null;
  let inflight = null;
  let lastRefreshReason = null;
  let lastFailureAt = -Infinity;
  const FAILURE_COOLDOWN_MS = 30000;
  const fallbackKey = `${key.replace(/:v\d+$/, "")}:v2:snapshot`;

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
    let rawCode = "";
    for (let depth = 0; cause && depth < 5; depth += 1) {
      if (cause.code) {rawCode = cause.code; break;}
      cause = cause.cause;
    }
    const code = String(rawCode);
    const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : "unknown";
    console.warn(`[${key}] ${phase} failed (${error?.name === "TypeError" ? "network" : "upstream"}, ${safeCode})`);
  }

  async function refresh(redis, force = false) {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!force && now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
        const previous = await readLastGood(redis) || await readFallback(redis);
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
          if (!candidate || !full(candidate)) throw new Error("主行情快照的结构或时间异常");
          fresh = candidate;
          lastGood = candidate;
          lastRefreshReason = null;
          lastFailureAt = -Infinity;
          if (onFull) { try { await onFull(result, redis); } catch { /* Full quote data remains valid. */ } }
          await persist(redis, candidate, true);
          return candidate.payload;
        }
      } catch (error) {
        logFailure("primary", error);
        // Raw upstream diagnostics must not appear in public responses.
      }
      lastRefreshReason = reason;
      lastFailureAt = now();
      const previous = await readLastGood(redis);
      if (previous) return stale(previous, reason);
      if (loadFallback) {
        try {
          const result = unpack(await loadFallback());
          const candidate = entry({...result.payload, partial: true}, now());
          if (!candidate) throw new Error("备用行情快照的结构或时间异常");
          fallback = candidate;
          if (onFull) { try { await onFull({...result, payload: candidate.payload}, redis); } catch { /* Aggregate fallback remains valid. */ } }
          await persist(redis, candidate, false);
          return candidate.payload;
        } catch (error) { logFailure("fallback", error); }
      }
      const previousFallback = await readFallback(redis);
      if (previousFallback) return stale(previousFallback, reason);
      if (reason === "market-closed") return emptyClosed(now());
      throw new Error("行情数据源暂不可用，且没有可用的历史快照，请稍后重试。");
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async get(redis, {retry = false} = {}) {
      const candidate = await readFresh(redis);
      if (!retry && candidate && sameShanghaiDate(candidate)) {
        if (age(candidate) < freshMs) return candidate.payload;
        if (age(candidate) < staleMs) {
          refresh(redis).catch(() => {});
          return stale(candidate, "revalidating");
        }
      }
      if (!retry) {
        const priorFull = await readLastGood(redis);
        if (priorFull) {
          const reason = lastRefreshReason || "cache-expired";
          refresh(redis).catch(() => {});
          return stale(priorFull, reason);
        }
      }
      if (!candidate && !retry) {
        const priorFull = await readLastGood(redis);
        if (!priorFull) {
          const priorFallback = await readFallback(redis);
          if (priorFallback && sameShanghaiDate(priorFallback) && age(priorFallback) < freshMs) return priorFallback.payload;
        }
      }
      if (!retry) {
        const previous = await readFallback(redis);
        if (previous) {
          const reason = lastRefreshReason || "cache-expired";
          refresh(redis).catch(() => {});
          return stale(previous, reason);
        }
      }
      return refresh(redis, retry);
    },
    lastGood: readLastGood,
    lastFallback: readFallback,
  };
}
