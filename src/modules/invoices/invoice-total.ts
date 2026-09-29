import type { Invoice } from '../../infrastructure/database/schema/invoices.schema';

/** TS twin of `invoiceTotalSql` in the repository: amount + lateFee + taxAmount - discountAmount. */
export function invoiceTotal(invoice: Invoice): number {
  return invoice.amount + invoice.lateFee + invoice.taxAmount - invoice.discountAmount;
}
