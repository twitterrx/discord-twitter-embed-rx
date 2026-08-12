import logger from "#/utils/logger.js";

import { redis } from "./init.js";

export async function connectRedis() {
  try {
    await redis.connect();
    if (redis.isReady) {
      logger.info("Redis client connected");
    } else {
      throw new Error("Redis client is not ready after connection attempt");
    }
  } catch (err) {
    logger.error("Redis connection failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
