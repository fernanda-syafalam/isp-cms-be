import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import {
  type NotificationSendInput,
  type NotificationSendResult,
  NotificationTransport,
} from './notification-transport';

/**
 * Fonnte/Wablas-class gateway response shape. ASSUMPTION (PR review item,
 * same caveat as `TRIPAY_METHOD` in `tripay-payment.gateway.ts`): copied
 * from Fonnte's publicly documented `/send` response at implementation
 * time — a boolean `status` plus an optional provider message id. Wablas'
 * shape is close enough (status + id) that this thin client should work
 * unmodified for either, but re-verify the exact field names against the
 * actual gateway account before flipping `NOTIFICATION_MODE=wa` in any
 * real environment.
 */
type WaGatewayResponse = {
  status?: boolean;
  reason?: string;
  message?: string;
  id?: string | string[];
};

/**
 * Live transport (`NOTIFICATION_MODE=wa`, ADR-0017). Talks to a
 * Fonnte/Wablas-class WhatsApp HTTP gateway over `fetch` (no new HTTP
 * client dependency — Node 22 ships a native `fetch`, same "thin client"
 * approach as `TripayPaymentGateway`).
 *
 * Never throws on a gateway/network failure — `send` returns
 * `{ delivered: false }` instead (see `NotificationTransport`'s doc
 * comment) so `NotificationsService.send` can write the `notification_log`
 * row before deciding whether to let BullMQ retry.
 */
@Injectable()
export class WhatsAppTransport extends NotificationTransport {
  private readonly logger = new Logger(WhatsAppTransport.name);
  private readonly apiUrl: string;
  private readonly apiToken: string;

  constructor(config: ConfigService<{ app: AppConfig }, true>) {
    super();
    // Validated non-empty by envSchema's superRefine when
    // NOTIFICATION_MODE=wa (the only mode this class is ever
    // instantiated+selected for — see notifications.module.ts) — the `?? ''`
    // is a type-narrowing formality, not a runtime fallback path that can
    // actually be hit in that mode.
    this.apiUrl = config.get('app.notifications.wa.apiUrl', { infer: true }) ?? '';
    this.apiToken = config.get('app.notifications.wa.apiToken', { infer: true }) ?? '';
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.apiToken,
        },
        body: JSON.stringify({ target: input.to, message: input.message }),
      });

      // A gateway can return a non-JSON body on an upstream error page —
      // never let a parse failure masquerade as a thrown (crash-the-job)
      // error; treat it as "gateway rejected", same as a false `status`.
      const json = (await res.json().catch(() => ({}) as WaGatewayResponse)) as WaGatewayResponse;

      if (!res.ok || json.status === false) {
        this.logger.warn(
          {
            to: input.to,
            event: input.event,
            httpStatus: res.status,
            reason: json.reason ?? json.message,
          },
          'WhatsApp gateway rejected the message',
        );
        return { delivered: false };
      }

      const providerRef = Array.isArray(json.id) ? json.id[0] : json.id;
      return { delivered: true, providerRef };
    } catch (err) {
      this.logger.error({ to: input.to, event: input.event, err }, 'WhatsApp gateway call failed');
      return { delivered: false };
    }
  }
}
