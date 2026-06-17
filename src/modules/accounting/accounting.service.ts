import { Injectable } from '@nestjs/common';
import { InvoicesRepository } from '../invoices/invoices.repository';
import type { JournalLine, JournalResponse } from './dto/journal-response.dto';

// Chart of accounts used by the cash-basis settlement journal.
const ACC_CASH = { code: '1110', name: 'Kas & Bank' };
const ACC_REVENUE = { code: '4100', name: 'Pendapatan Jasa Internet' };
const ACC_LATE_FEE = { code: '4200', name: 'Pendapatan Denda' };
const ACC_OUTPUT_VAT = { code: '2130', name: 'PPN Keluaran' };

/**
 * Allowed sort keys for journal lines.
 * Unknown/absent keys fall back to the natural (chronological) posting order.
 */
const SORT_WHITELIST = new Set(['date', 'accountCode', 'accountName', 'debit', 'credit'] as const);
type SortKey = 'date' | 'accountCode' | 'accountName' | 'debit' | 'credit';

export type JournalFilter = {
  period: string;
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
};

@Injectable()
export class AccountingService {
  constructor(private readonly invoices: InvoicesRepository) {}

  /**
   * Build the period journal from invoices settled that month (cash-basis):
   * each payment debits Cash for the total and credits Revenue (+ late-fee
   * and output-VAT when present). Debit and credit totals balance.
   *
   * Special contract:
   * - `totals` is computed over ALL posting lines for the period and is
   *   NEVER affected by `q`, `limit`, or `offset`.
   * - `total` is the count of lines AFTER `q` filtering but BEFORE paging.
   * - `lines` is the current page (after q-filter, sort, limit/offset).
   */
  async getJournal(filter: JournalFilter): Promise<JournalResponse> {
    const paid = await this.invoices.findPaidInPeriod(filter.period);
    const allLines: JournalLine[] = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const inv of paid) {
      const at = (inv.paidAt ?? inv.createdAt).toISOString();
      const total = inv.amount + inv.lateFee + inv.taxAmount;

      allLines.push(
        makeLine(
          `${inv.id}-dr`,
          at,
          ACC_CASH,
          `Pelunasan ${inv.invoiceNo} - ${inv.customerName}`,
          total,
          0,
        ),
      );
      totalDebit += total;

      allLines.push(
        makeLine(`${inv.id}-rev`, at, ACC_REVENUE, `Pendapatan ${inv.invoiceNo}`, 0, inv.amount),
      );
      totalCredit += inv.amount;

      if (inv.lateFee > 0) {
        allLines.push(
          makeLine(`${inv.id}-fee`, at, ACC_LATE_FEE, `Denda ${inv.invoiceNo}`, 0, inv.lateFee),
        );
        totalCredit += inv.lateFee;
      }
      if (inv.taxAmount > 0) {
        allLines.push(
          makeLine(`${inv.id}-tax`, at, ACC_OUTPUT_VAT, `PPN ${inv.invoiceNo}`, 0, inv.taxAmount),
        );
        totalCredit += inv.taxAmount;
      }
    }

    // --- SPECIAL RULE #1: totals are always the full-period aggregate ---
    const totals = { debit: totalDebit, credit: totalCredit };

    // --- SPECIAL RULE #2: q/sort/limit/offset apply only to the returned lines ---

    // Step 1: q-filter (case-insensitive substring over accountCode, accountName, description)
    const filtered = filter.q ? applySearch(allLines, filter.q) : allLines;

    // Step 2: count BEFORE paging (for DataTable page-count math)
    const total = filtered.length;

    // Step 3: sort
    const sorted = applySort(filtered, filter.sort, filter.order);

    // Step 4: page
    const lines = sorted.slice(filter.offset, filter.offset + filter.limit);

    return { period: filter.period, lines, total, totals };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLine(
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

function applySearch(lines: JournalLine[], q: string): JournalLine[] {
  const lower = q.toLowerCase();
  return lines.filter(
    (l) =>
      l.accountCode.toLowerCase().includes(lower) ||
      l.accountName.toLowerCase().includes(lower) ||
      l.description.toLowerCase().includes(lower),
  );
}

/**
 * Sort journal lines in-memory.
 * Unknown or absent `sortKey` falls back to the natural (insertion) order,
 * which is the chronological posting order emitted by the loop above.
 * Never throws on an unrecognised key.
 */
function applySort(
  lines: JournalLine[],
  sortKey: string | undefined,
  order: 'asc' | 'desc' | undefined,
): JournalLine[] {
  if (!sortKey || !SORT_WHITELIST.has(sortKey as SortKey)) {
    // Natural posting order — return a shallow copy to avoid mutating allLines.
    return [...lines];
  }

  const key = sortKey as SortKey;
  const dir = order === 'desc' ? -1 : 1;

  return [...lines].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}
