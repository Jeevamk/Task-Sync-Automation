import {
  Controller,
  Head,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  TrelloWebhookBody,
  TrelloWebhookService,
} from "./trello-webhook.service";

@Controller("webhooks/trello")
export class TrelloWebhookController {
  constructor(private readonly service: TrelloWebhookService) {}

  /** Trello sends HEAD when the webhook is registered and expects 200. */
  @Head()
  @HttpCode(200)
  head(): void {}

  /** Bad signature -> 401. Processing error -> 500, so Trello retries (duplicates are skipped safely). */
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-trello-webhook") signature: string | undefined,
  ): Promise<{ ok: true; outcome: string }> {
    if (!this.service.isSignatureValid(req.rawBody, signature)) {
      throw new UnauthorizedException("Invalid Trello signature");
    }
    const result = await this.service.handle(req.body as TrelloWebhookBody);
    return { ok: true, outcome: result.outcome };
  }
}
