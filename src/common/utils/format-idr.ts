/**
 * Whole-rupiah formatting for notification template variables, e.g.
 * "Rp250.000". Shared by InvoicesService and BillingAutomationService,
 * which previously carried identical copies of this function.
 */
export function formatIdr(amount: number): string {
  return `Rp${amount.toLocaleString('id-ID')}`;
}
