import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody is needed later to verify Trello and Slack signatures.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`Task Sync API running on http://localhost:${port}  (health: /health)`, 'Bootstrap');
}

void bootstrap();
