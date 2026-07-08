import type { Logger } from '@nestjs/common';

// A notification enqueue failure (e.g. Redis unavailable) must never break
// the write that already committed (invoice, work order, ticket, ...) — log
// and swallow rather than rethrow (ADR-0012). Shared by
// InvoicesService/WorkOrdersService/TicketsService so the resilience
// contract can't drift between the three copies it used to be.
export async function notifyBestEffort(
  logger: Logger,
  fn: () => Promise<void>,
  context: Record<string, unknown>,
  message = 'notification enqueue failed',
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ ...context, err }, message);
  }
}
