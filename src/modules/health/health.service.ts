import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export type CheckResult = { status: 'up' | 'down'; error?: string };

export interface HealthReport {
  status: 'ok' | 'error';
  checks: { database: CheckResult; n8n: CheckResult };
  outbox?: Record<string, number>;
  time: string;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, n8n] = await Promise.all([
      this.run(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.run(async () => {
        const base = this.config.getOrThrow<string>('N8N_BASE_URL').replace(/\/$/, '');
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }),
    ]);

    // How many events are waiting / sent / failed (useful while testing)
    let outbox: Record<string, number> | undefined;
    if (database.status === 'up') {
      const groups = await this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } });
      outbox = Object.fromEntries(
        groups.map((g: { status: string; _count: { _all: number } }) => [g.status, g._count._all]),
      );
    }

    const allUp = database.status === 'up' && n8n.status === 'up';
    return { status: allUp ? 'ok' : 'error', checks: { database, n8n }, outbox, time: new Date().toISOString() };
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