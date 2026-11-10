import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idShort: number;
  shortUrl: string;
  due: string | null;
  idMembers: string[];
  labels: { name: string; color: string | null }[];
  closed: boolean;
}

/** Small wrapper around the Trello REST API (only the calls this project needs). */
@Injectable()
export class TrelloClient {
  private readonly logger = new Logger(TrelloClient.name);
  private botMemberId?: string;

  constructor(private readonly config: ConfigService) {}

  getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>("GET", `/cards/${cardId}`, {
      fields: "id,name,desc,idList,idShort,shortUrl,due,idMembers,labels,closed",
    });
  }

  /** All open cards on a board (used to import existing tasks). */
  getBoardCards(boardId: string): Promise<TrelloCard[]> {
    return this.request<TrelloCard[]>("GET", `/boards/${boardId}/cards/open`, {
      fields: "id,name,desc,idList,idShort,shortUrl,due,idMembers,labels,closed",
    });
  }

    /** Lists (columns) on a board, including archived ones (closed: true). */
  getBoardLists(boardId: string): Promise<{ id: string; name: string; closed: boolean }[]> {
    return this.request('GET', `/boards/${boardId}/lists`, { fields: 'id,name,closed', filter: 'all' });
  }

  /** Labels defined on a board. */
  getBoardLabels(boardId: string): Promise<{ id: string; name: string; color: string | null }[]> {
    return this.request('GET', `/boards/${boardId}/labels`, { fields: 'id,name,color', limit: '1000' });
  }

  /** Create a card; it is added at the bottom of the list. */
  createCard(input: {
    idList: string;
    name: string;
    desc?: string;
    due?: string;
    idMembers?: string[];
    idLabels?: string[];
  }): Promise<{ id: string; shortUrl: string; idShort: number }> {
    const params: Record<string, string> = { idList: input.idList, name: input.name, pos: 'bottom' };
    if (input.desc) params.desc = input.desc;
    if (input.due) params.due = input.due;
    if (input.idMembers?.length) params.idMembers = input.idMembers.join(',');
    if (input.idLabels?.length) params.idLabels = input.idLabels.join(',');
    return this.request('POST', '/cards', params);
  }

  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.request("PUT", `/cards/${cardId}`, { idList: listId });
  }

  /** The Trello member the token belongs to (to ignore comments the system wrote itself). */
  async getBotMemberId(): Promise<string> {
    if (!this.botMemberId) {
      const me = await this.request<{ id: string }>("GET", "/members/me", {
        fields: "id",
      });
      this.botMemberId = me.id;
    }
    return this.botMemberId;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`https://api.trello.com/1${path}`);
    url.searchParams.set("key", this.config.getOrThrow("TRELLO_API_KEY"));
    url.searchParams.set("token", this.config.getOrThrow("TRELLO_TOKEN"));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      this.logger.error(`Trello ${method} ${path} -> ${res.status} ${text}`);
      throw new Error(`Trello ${method} ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }
}
