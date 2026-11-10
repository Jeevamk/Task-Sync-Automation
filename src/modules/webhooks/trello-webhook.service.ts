import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { OutboxService } from "../outbox/outbox.service";
import {
  CardSnapshot,
  ChangeResult,
  TaskChange,
  TasksService,
} from "../tasks/tasks.service";
import { TrelloClient } from "../trello/trello.client";
import { runInBackground } from "../../common/background";

/** The parts of a Trello webhook payload we read. */
export interface TrelloWebhookBody {
  action?: {
    id: string;
    type: string;
    date: string;
    idMemberCreator?: string;
    memberCreator?: { fullName?: string };
    member?: { id?: string; fullName?: string };
    data?: {
      board?: { id: string };
      card?: {
        id: string;
        name?: string;
        desc?: string;
        idShort?: number;
        shortLink?: string;
        idList?: string;
        due?: string | null;
        closed?: boolean;
      };
      list?: { id: string };
      listAfter?: { id: string };
      listBefore?: { id: string };
      old?: Record<string, unknown>;
      idMember?: string;
      text?: string;
    };
  };
}

@Injectable()
export class TrelloWebhookService {
  private readonly logger = new Logger(TrelloWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly trello: TrelloClient,
    private readonly outbox: OutboxService,
  ) {}

  /** The exact URL Trello calls. It is part of the signature, so it must match the registered URL. */
  callbackUrl(): string {
    return `${this.config.getOrThrow<string>("PUBLIC_BASE_URL").replace(/\/$/, "")}/webhooks/trello`;
  }

  /** Trello signs each request: Base64( HMAC-SHA1( appSecret, rawBody + callbackURL ) ). */
  isSignatureValid(
    rawBody: Buffer | undefined,
    header: string | undefined,
  ): boolean {
    if (!rawBody || !header) return false;
    const secret = this.config.getOrThrow<string>("TRELLO_APP_SECRET");
    const expected = createHmac("sha1", secret)
      .update(Buffer.concat([rawBody, Buffer.from(this.callbackUrl(), "utf8")]))
      .digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handle(body: TrelloWebhookBody): Promise<ChangeResult> {
    const action = body.action;
    const cardId = action?.data?.card?.id;
    const boardId = action?.data?.board?.id;
    if (!action || !cardId || !boardId)
      return { outcome: "ignored", reason: "not a card action" };

    const project = await this.prisma.project.findUnique({
      where: { trelloBoardId: boardId },
    });
    if (!project || !project.active)
      return {
        outcome: "ignored",
        reason: `board ${boardId} is not a registered project`,
      };

    const change = await this.toChange(action);
    if (!change)
      return { outcome: "ignored", reason: `action ${action.type} not used` };

    // New card for us? Fetch its current details so the task can be created.
    let card: CardSnapshot | undefined;
    const known = await this.prisma.task.findUnique({
      where: { trelloCardId: cardId },
      select: { id: true },
    });
    if (!known) {
      const c = await this.trello.getCard(cardId);
      card = {
        name: c.name,
        description: c.desc,
        idList: c.idList,
        idShort: c.idShort,
        url: c.shortUrl,
        due: c.due,
        idMembers: c.idMembers,
        labels: c.labels.map((l) => l.name).filter(Boolean),
      };
    }

    const result = await this.tasks.applyChange({
      projectId: project.id,
      trelloCardId: cardId,
      source: "TRELLO",
      externalId: action.id,
      actorTrelloId: action.idMemberCreator,
      actorName: action.memberCreator?.fullName,
      occurredAt: new Date(action.date),
      card,
      change,
    });

    this.logger.log(
      `${action.type} on card ${cardId}: ${result.outcome}` +
        `${result.eventType ? ` (${result.eventType})` : ""}${result.reason ? ` - ${result.reason}` : ""}`,
    );

    if (result.outcome === "applied") this.outbox.flushSoon();
    if (result.moveCardToListId) {
      const listId = result.moveCardToListId;
      runInBackground("move card to Assigned", () =>
        this.trello.moveCard(cardId, listId),
      );
    }
    return result;
  }

  /** Turn a Trello action into a task change (or null if we don't use that action). */
  private async toChange(
    action: NonNullable<TrelloWebhookBody["action"]>,
  ): Promise<TaskChange | null> {
    const d = action.data ?? {};
    switch (action.type) {
      case "createCard":
        return { kind: "created" };

      case "updateCard": {
        if (d.listAfter?.id) return { kind: "moved", toListId: d.listAfter.id };
        const old = d.old ?? {};
        if ("closed" in old && d.card?.closed) return { kind: "archived" };
        if ("name" in old && d.card?.name)
          return { kind: "renamed", title: d.card.name };
        if ("due" in old) return { kind: "due", due: d.card?.due ?? null };
        if ("desc" in old) return { kind: "description", text: d.card?.desc ?? "" };
        return null;
      }

      case "addMemberToCard":
        return d.idMember
          ? {
              kind: "assigned",
              memberTrelloId: d.idMember,
              memberName: action.member?.fullName,
            }
          : null;

      case "removeMemberFromCard":
        return d.idMember
          ? { kind: "unassigned", memberTrelloId: d.idMember }
          : null;

      case "commentCard": {
        if (!d.text) return null;
        // Skip comments the system writes itself (they start with "[Task Sync]").
        const botId = await this.trello.getBotMemberId().catch(() => undefined);
        if (
          botId &&
          action.idMemberCreator === botId &&
          d.text.startsWith("[Task Sync]")
        )
          return null;
        return { kind: "comment", text: d.text };
      }

      default:
        return null;
    }
  }
}
