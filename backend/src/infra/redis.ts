import { Redis } from 'ioredis';
import type { AppConfig } from '../config/index.js';

export function createRedisClient(config: Pick<AppConfig, 'redis'>): Redis {
  return new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
}

export async function pingRedis(client: Redis): Promise<void> {
  // ioredis types PING's reply as the literal "PONG", but we compare
  // against a widened string at runtime defensively (e.g. against a proxy
  // or a future ioredis version that types this more loosely).
  const reply: string = await client.ping();
  if (reply !== 'PONG') {
    throw new Error(`Unexpected PING reply from Redis: ${reply}`);
  }
}
