import { createClient } from "redis";

import logger from "#/utils/logger.js";

if (!process.env.REDIS_URL) {
  logger.warn("REDIS_URL is not set, using default localhost");
}

export const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

export type AppRedisClient = typeof redis;

redis.on("error", (err) =>
  logger.error("Redis Client Error", { error: err instanceof Error ? err.message : String(err) })
);
