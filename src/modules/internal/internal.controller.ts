import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { FlushResult, OutboxService } from '../outbox/outbox.service';
import { TasksService } from '../tasks/tasks.service';
import { TrelloClient } from '../trello/trello.client';

/** For n8n, Vercel Cron and the setup script only (X-Api-Key or Bearer CRON_SECRET). */
@Controller('internal')
@UseGuards(InternalApiKeyGuard)
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly tasks: TasksService,
    private readonly trello: TrelloClient,
  ) {}

  /** Import every open card of the project's board. Safe to run again: known cards are skipped. */
  @Post('projects/:id/import')
  async importProject(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ imported: number; skipped: number }> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');

    const cards = await this.trello.getBoardCards(project.trelloBoardId);
    let imported = 0;
    let skipped = 0;
    for (const c of cards.sort((a, b) => a.idShort - b.idShort)) {
      const result = await this.tasks.applyChange({
        projectId: project.id,
        trelloCardId: c.id,
        source: 'SYSTEM',
        externalId: `import:${c.id}`,
        occurredAt: new Date(),
        card: {
          name: c.name,
          idList: c.idList,
          idShort: c.idShort,
          url: c.shortUrl,
          due: c.due,
          idMembers: c.idMembers,
          labels: c.labels.map((l) => l.name).filter(Boolean),
        },
        change: { kind: 'created' },
      });
      if (result.outcome === 'applied') imported++;
      else skipped++;
    }
    await this.outbox.flushPending(100);
    return { imported, skipped };
  }

  /** n8n saves the Slack parent message timestamp (and optionally the sheet row). */
  @Patch('tasks/:id/delivery')
  async saveDelivery(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { slackThreadTs?: unknown; sheetRow?: unknown },
  ): Promise<{ ok: true; slackThreadTs: string | null; sheetRow: number | null }> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');

    const raw = body?.slackThreadTs;
    const ts = typeof raw === 'string' && /^\d+\.\d+$/.test(raw) ? raw : undefined;
    if (raw !== undefined && raw !== null && raw !== '' && !ts) {
      throw new BadRequestException('slackThreadTs must look like 1730712345.001200');
    }
    const row = Number.isInteger(body?.sheetRow) && (body.sheetRow as number) > 1 ? (body.sheetRow as number) : undefined;

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(ts && !task.slackThreadTs ? { slackThreadTs: ts } : {}), // never replace the first thread
        ...(row ? { sheetRow: row } : {}),
      },
    });
    return { ok: true, slackThreadTs: updated.slackThreadTs, sheetRow: updated.sheetRow };
  }

  /** Vercel Cron calls GET; you can call POST by hand. */
  @Get('outbox/flush')
  flushByCron(): Promise<FlushResult> {
    return this.outbox.flushPending();
  }

  @Post('outbox/flush')
  flushByHand(): Promise<FlushResult> {
    return this.outbox.flushPending();
  }

  @Get('outbox/status')
  async status(): Promise<Record<string, number>> {
    const groups = await this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(groups.map((g: { status: string; _count: { _all: number } }) => [g.status, g._count._all]));
  }
}