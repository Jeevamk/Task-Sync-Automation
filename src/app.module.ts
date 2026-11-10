import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { envValidationSchema } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";
import { OutboxModule } from "./modules/outbox/outbox.module";
import { TrelloModule } from "./modules/trello/trello.module";
import { TasksModule } from "./modules/tasks/tasks.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { InternalModule } from "./modules/internal/internal.module";
import { SheetsModule } from "./modules/sheets/sheets.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    PrismaModule,
    HealthModule,
    OutboxModule,
    TrelloModule,
    TasksModule,
    HealthModule,
    WebhooksModule,
    InternalModule,
    SheetsModule
  ],
})
export class AppModule {}
