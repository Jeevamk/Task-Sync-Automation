import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { runInBackground } from '../../common/background';

type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 8;
const CLAIM_LEASE_MS = 60_000;

export interface FlushResult {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Outbox pattern: the event is saved in the SAME transaction as the task change,
 * then sent to n8n (WF1) and retried until it succeeds.
 * Sent: right after each change (waitUntil), by Vercel Cron, and locally by a timer.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private flushAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const every = this.config.get<number>('OUTBOX_POLL_MS', 0);
    if (every > 0 && !process.env.VERCEL) {
      this.timer = setInterval(() => void this.flushPending(), every);
      this.timer.unref();
      this.logger.log(`Local outbox polling every ${every} ms`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Save an event inside the caller's transaction. */
  async enqueue(tx: Tx, type: string, payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await tx.outboxEvent.create({
      data: { id, type, payload: { eventId: id, type, ...payload } as Prisma.InputJsonValue },
    });
    return id;
  }

  /** Send pending events soon, without delaying the HTTP response. */
  flushSoon(): void {
    runInBackground('outbox flush', () => this.flushPending());
  }

  /** Send every pending event that is due. */
  async flushPending(limit = 25): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, retried: 0, failed: 0 };
    if (this.flushing) {
      this.flushAgain = true; // already running: run once more when done
      return result;
    }
    this.flushing = true;
    try {
      const due = await this.prisma.outboxEvent.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });

      for (const event of due) {
        // Claim the row so another server instance does not send it at the same time.
        const claimed = await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, status: 'PENDING', attempts: event.attempts },
          data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) },
        });
        if (claimed.count === 0) continue;

        const attempt = event.attempts + 1;
        try {
          await this.send(await this.withLatestThread(event.payload as Record<string, unknown>));
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'SENT', sentAt: new Date(), lastError: null },
          });
          result.sent++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= MAX_ATTEMPTS) {
            await this.prisma.$transaction([
              this.prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', lastError: message } }),
              this.prisma.syncError.create({
                data: {
                  step: 'n8n.deliver',
                  error: message,
                  payload: event.payload as Prisma.InputJsonValue,
                  projectId: (event.payload as { project?: { id?: string } }).project?.id ?? null,
                  taskId: (event.payload as { task?: { id?: string } }).task?.id ?? null,
                },
              }),
            ]);
            this.logger.error(`Event ${event.id} (${event.type}) failed permanently: ${message}`);
            result.failed++;
          } else {
            const delay = Math.min(5_000 * 2 ** (attempt - 1), 30 * 60_000);
            await this.prisma.outboxEvent.update({
              where: { id: event.id },
              data: { lastError: message, nextAttemptAt: new Date(Date.now() + delay) },
            });
            this.logger.warn(`Event ${event.id} attempt ${attempt} failed, retry in ${delay / 1000}s: ${message}`);
            result.retried++;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    if (this.flushAgain) {
      this.flushAgain = false;
      const more = await this.flushPending(limit);
      result.sent += more.sent;
      result.retried += more.retried;
      result.failed += more.failed;
    }
    if (result.sent || result.retried || result.failed) {
      this.logger.log(`Outbox: sent ${result.sent}, retry ${result.retried}, failed ${result.failed}`);
    }
    return result;
  }

  /**
   * The Slack thread is created by n8n after the first event. Fill in the task's current
   * thread at send time, so a quick second event replies in the thread instead of starting a new one.
   */
  private async withLatestThread(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = payload.task as { id?: string; slackThreadTs?: string | null } | undefined;
    if (!task?.id || task.slackThreadTs) return payload;
    const current = await this.prisma.task.findUnique({ where: { id: task.id }, select: { slackThreadTs: true } });
    return current?.slackThreadTs ? { ...payload, task: { ...task, slackThreadTs: current.slackThreadTs } } : payload;
  }

  /** POST one event to n8n WF1, signed with HMAC-SHA256 over the exact body. */
  private async send(payload: Record<string, unknown>): Promise<void> {
    const url = this.config.getOrThrow<string>('N8N_EVENT_WEBHOOK_URL');
    const secret = this.config.getOrThrow<string>('N8N_EVENT_SIGNING_SECRET');
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`,
        'X-Event-Id': String(payload.eventId ?? ''),
      },
      body,
      // WF1 answers when it has finished (Sheets + Slack), so allow time for it.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`n8n responded ${res.status}: ${text}`);
    }
  }
}