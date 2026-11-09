import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody: needed to verify Trello (and later Slack) signatures over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
  Logger.log(`Task Sync API running on port ${port}  (health: /health)`, 'Bootstrap');
}

void bootstrap();