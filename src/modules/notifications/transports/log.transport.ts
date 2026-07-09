import { Injectable, Logger } from '@nestjs/common';
import {
  type NotificationSendInput,
  type NotificationSendResult,
  NotificationTransport,
} from './notification-transport';

/**
 * Default delivery mode (dev/test/demo, `NOTIFICATION_MODE=log`). This is
 * the behavior notifications had before the transport seam existed: no
 * external call — the `notification_log` row that `NotificationsService.send`
 * writes unconditionally is the only observable effect.
 */
@Injectable()
export class LogTransport extends NotificationTransport {
  private readonly logger = new Logger(LogTransport.name);

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    this.logger.log(
      { to: input.to, event: input.event },
      'log transport: would send WhatsApp message (NOTIFICATION_MODE=log)',
    );
    return { delivered: true };
  }
}
