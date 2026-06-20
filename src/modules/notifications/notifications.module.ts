import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsController } from './notifications.controller';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Module({
  // Register the queue (producer side, NotificationsService) and the processor
  // (consumer side, runs in the worker process) so dunning is delivered with
  // retries instead of being dropped — ADR-0012.
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository, NotificationsProcessor],
  // Exported so billing/tickets can fire templated notifications.
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
