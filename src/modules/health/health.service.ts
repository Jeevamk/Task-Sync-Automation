import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';

export type CheckResult = { status: 'up' | 'down'; error?: string };

export interface HealthReport {
  status: 'ok' | 'error';
  checks: { database: CheckResult; redis: CheckResult; n8n: CheckResult };
  time: string;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis, n8n] = await Promise.all([
      this.run(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.run(async () => {
        const pong = await this.redis.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected reply: ${pong}`);
      }),
      this.run(async () => {
        const base = this.config.getOrThrow<string>('N8N_BASE_URL').replace(/\/$/, '');
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }),
    ]);

    const allUp = [database, redis, n8n].every((c) => c.status === 'up');
    return {
      status: allUp ? 'ok' : 'error',
      checks: { database, redis, n8n },
      time: new Date().toISOString(),
    };
  }

  private async run(fn: () => Promise<void>): Promise<CheckResult> {
    try {
      await fn();
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
