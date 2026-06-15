import { Injectable } from '@nestjs/common';
import { InvoicesRepository } from '../invoices/invoices.repository';
import type { JournalLine, JournalResponse } from './dto/journal-response.dto';

// Chart of accounts used by the cash-basis settlement journal.
const ACC_CASH = { code: '1110', name: 'Kas & Bank' };
const ACC_REVENUE = { code: '4100', name: 'Pendapatan Jasa Internet' };
const ACC_LATE_FEE = { code: '4200', name: 'Pendapatan Denda' };
const ACC_OUTPUT_VAT = { code: '2130', name: 'PPN Keluaran' };

@Injectable()
export class AccountingService {
  constructor(private readonly invoices: InvoicesRepository) {}

  /**
   * Build the period journal from invoices settled that month (cash-basis):
   * each payment debits Cash for the total and credits Revenue (+ late-fee
   * and output-VAT when present). Debit and credit totals balance.
   */
  async getJournal(period: string): Promise<JournalResponse> {
    const paid = await this.invoices.findPaidInPeriod(period);
    const lines: JournalLine[] = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const inv of paid) {
      const at = (inv.paidAt ?? inv.createdAt).toISOString();
      const total = inv.amount + inv.lateFee + inv.taxAmount;

      lines.push(
        line(
          `${inv.id}-dr`,
          at,
          ACC_CASH,
          `Pelunasan ${inv.invoiceNo} - ${inv.customerName}`,
          total,
          0,
        ),
      );
      totalDebit += total;

      lines.push(
        line(`${inv.id}-rev`, at, ACC_REVENUE, `Pendapatan ${inv.invoiceNo}`, 0, inv.amount),
      );
      totalCredit += inv.amount;

      if (inv.lateFee > 0) {
        lines.push(
          line(`${inv.id}-fee`, at, ACC_LATE_FEE, `Denda ${inv.invoiceNo}`, 0, inv.lateFee),
        );
        totalCredit += inv.lateFee;
      }
      if (inv.taxAmount > 0) {
        lines.push(
          line(`${inv.id}-tax`, at, ACC_OUTPUT_VAT, `PPN ${inv.invoiceNo}`, 0, inv.taxAmount),
        );
        totalCredit += inv.taxAmount;
      }
    }

    return { period, lines, totals: { debit: totalDebit, credit: totalCredit } };
  }
}

function line(
  id: string,
  date: string,
  account: { code: string; name: string },
  description: string,
  debit: number,
  credit: number,
): JournalLine {
  return {
    id,
    date,
    accountCode: account.code,
    accountName: account.name,
    description,
    debit,
    credit,
  };
}
