import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { LogTransport } from './transports/log.transport';
import { NotificationTransport } from './transports/notification-transport';
import { WhatsAppTransport } from './transports/whatsapp.transport';

/**
 * PRODUCER side only (R10-OPS-1). Registers the `notifications` queue so
 * NotificationsService can enqueue dunning/lifecycle events, and exposes the
 * manual-reminder HTTP endpoint (NotificationsController). Imported by
 * AppModule (API) and every domain module that fires a notification
 * (customers, tickets, work-orders, invoices).
 *
 * The consumer (NotificationsProcessor, the BullMQ WorkerHost that actually
 * delivers the job) is registered ONLY in NotificationsWorkerModule, which
 * imports this module and is wired into WorkerModule alone — the API process
 * must never instantiate a queue processor (Pilar 7 / ADR-0012's follow-up).
 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
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
