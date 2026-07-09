/**
 * Delivery seam for the `notifications` queue (ADR-0017), mirroring the
 * `RouterAdapter` (`router-resources/adapters/router-adapter.ts`) and
 * `PaymentGateway` (`invoices/payment-gateway/payment-gateway.ts`) pattern:
 * an abstract class (not a bare interface) so it doubles as a Nest DI
 * token, selected by `NOTIFICATION_MODE` in `notifications.module.ts`.
 *
 * `NotificationsService.send` always writes the `notification_log` row
 * first (the RECORD — kept regardless of which transport is selected) and
 * then hands the rendered message to this seam (the SEND). `LogTransport`
 * (`NOTIFICATION_MODE=log`, default) reproduces the pre-existing behavior
 * byte-for-byte: no external call, always "delivered". `WhatsAppTransport`
 * (`NOTIFICATION_MODE=wa`) is the only implementation that talks to a real
 * WhatsApp gateway.
 */

/** One outbound message, already rendered — the transport never sees a
 *  template or placeholders, only the final text. */
export type NotificationSendInput = {
  to: string;
  event: string;
  message: string;
};

export type NotificationSendResult = {
  delivered: boolean;
  /** The provider's own message/transaction id, when it returns one —
   *  stored for reconciliation only, never used as a lookup key. */
  providerRef?: string;
};

export abstract class NotificationTransport {
  /**
   * Attempt delivery. MUST NOT throw for a transport-level failure (a
   * gateway timeout, non-2xx response, network error) — return
   * `{ delivered: false }` instead. `NotificationsService.send` logs the
   * outcome to `notification_log` either way and rethrows on a
   * non-delivered result so the notifications queue's existing BullMQ
   * retry/backoff (`NotificationsProcessor`) picks it up — a delivery
   * failure must be recorded and retried, never silently dropped or
   * allowed to crash the worker process.
   */
  abstract send(input: NotificationSendInput): Promise<NotificationSendResult>;
}
