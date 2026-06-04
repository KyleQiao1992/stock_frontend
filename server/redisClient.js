import { createClient } from "redis";
import { loadServerEnv } from "./env.js";

loadServerEnv();

let client = null;
let connectPromise = null;

export function getRedisUrl() {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured.");
  }
  return redisUrl;
}

export async function getRedisClient() {
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  client = createClient({
    url: getRedisUrl(),
    socket: {
      reconnectStrategy: false,
      connectTimeout: 5000,
    },
  });

  client.on("error", (error) => {
    console.error("Redis client error", error);
  });

  connectPromise = client.connect().then(() => client);

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}
