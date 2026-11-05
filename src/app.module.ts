import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    // Added in later steps: TasksModule, WebhooksModule, TrelloModule, SlackModule,
    // OutboxModule, ProjectsModule, TeamModule, InternalModule, AuthModule ...
  ],
})
export class AppModule {}
