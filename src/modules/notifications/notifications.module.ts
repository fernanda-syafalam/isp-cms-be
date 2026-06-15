import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  // Exported so billing/tickets can fire templated notifications later.
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
