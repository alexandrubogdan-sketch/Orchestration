import { Redis } from 'ioredis';
import type { AppConfig } from '../config/index.js';

export function createRedisClient(config: Pick<AppConfig, 'redis'>): Redis {
  return new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
}

export async function pingRedis(client: Redis): Promise<void> {
  const reply: string = await client.ping();
  if (reply !== 'PONG') {
    throw new Error(`Unexpected PING reply from Redis: ${reply}`);
  }
}
