import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

/**
 * The worker process. In Step 2 the BullMQ processors (Trello calls, outbox
 * dispatcher to n8n) are registered here.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),
    PrismaModule,
    RedisModule,
  ],
})
export class WorkerModule {}
