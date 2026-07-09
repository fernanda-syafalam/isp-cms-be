import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsController } from './notifications.controller';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { LogTransport } from './transports/log.transport';
import { NotificationTransport } from './transports/notification-transport';
import { WhatsAppTransport } from './transports/whatsapp.transport';

@Module({
  // Register the queue (producer side, NotificationsService) and the processor
  // (consumer side, runs in the worker process) so dunning is delivered with
  // retries instead of being dropped — ADR-0012.
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationsProcessor,
    // Select the delivery transport by NOTIFICATION_MODE (ADR-0017): 'wa'
    // sends through a real WhatsApp gateway; 'log' (default) reproduces the
    // pre-existing DB-log-only behavior. Same DI-token-selection pattern as
    // RouterAdapter (router-resources.module.ts) / PaymentGateway
    // (invoices.module.ts).
    LogTransport,
    WhatsAppTransport,
    {
      provide: NotificationTransport,
      inject: [ConfigService, LogTransport, WhatsAppTransport],
      useFactory: (
        config: ConfigService<{ app: AppConfig }, true>,
        log: LogTransport,
        wa: WhatsAppTransport,
      ) => (config.get('app.notifications.mode', { infer: true }) === 'wa' ? wa : log),
    },
  ],
  // Exported so billing/tickets can fire templated notifications.
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
