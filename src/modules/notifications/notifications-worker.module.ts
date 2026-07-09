import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsProcessor } from './notifications.processor';

/**
 * CONSUMER side only (R10-OPS-1). Registers NotificationsProcessor — the
 * BullMQ WorkerHost that actually delivers a `notifications` job via
 * NotificationsService.send — and imports NotificationsModule to reuse its
 * exported NotificationsService (which already wires the repository +
 * transport) instead of re-registering the queue or duplicating providers.
 *
 * Imported ONLY by WorkerModule. Never import this from AppModule or any
 * API-side module: doing so would instantiate the processor in the API
 * process again, reintroducing R10-OPS-1.
 */
@Module({
  imports: [NotificationsModule],
  providers: [NotificationsProcessor],
})
export class NotificationsWorkerModule {}
