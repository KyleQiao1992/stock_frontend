import { createClient } from "redis";
import { loadServerEnv } from "./env.js";

loadServerEnv();

export function getRedisUrl() {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured.");
  }
  return redisUrl;
}

function logRedisError(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : "CONNECTION_ERROR";
  console.error("Redis client error", code);
}

export function createRedisClientProvider({ makeClient = createClient, getUrl = getRedisUrl,
  connectTimeoutMs = 5000, logError = logRedisError } = {}) {
  let client = null;
  let connectPromise = null;

  return async function getClient() {
    if (connectPromise) return connectPromise;
    if (client?.isReady) return client;

    if (client?.isOpen) client.destroy();
    client = null;
    const candidate = makeClient({
      url: getUrl(),
      socket: { reconnectStrategy: false, connectTimeout: connectTimeoutMs },
    });
    client = candidate;
    candidate.on("error", logError);

    // node-redis's socket deadline ends at TCP connect, before its handshake.
    // Bound that entire attempt and destroy it before another one can start.
    let timer;
    const attempt = (async () => {
      try {
        await Promise.race([
          Promise.resolve().then(() => candidate.connect()),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error("Redis connection did not become ready within the connection deadline.");
              error.code = "REDIS_CONNECT_TIMEOUT";
              reject(error);
            }, connectTimeoutMs);
          }),
        ]);
        if (!candidate.isReady) throw new Error("Redis connection did not become ready.");
        return candidate;
      } catch (error) {
        if (client === candidate) client = null;
        if (candidate.isOpen) candidate.destroy();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      if (connectPromise === attempt) connectPromise = null;
    });
    connectPromise = attempt;
    return attempt;
  };
}

export const getRedisClient = createRedisClientProvider();
