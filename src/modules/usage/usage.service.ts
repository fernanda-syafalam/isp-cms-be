import { Injectable, NotFoundException } from '@nestjs/common';
import { CustomersRepository } from '../customers/customers.repository';
import type { UsageResponse, UsageSummary } from './dto/usage-response.dto';

// Quota derived from plan speed: >=100 Mbps unlimited, >=50 -> 1000 GB,
// else 500 GB. Matches the FE contract.
function quotaForSpeed(speedMbps: number): number {
  if (speedMbps >= 100) return 0;
  if (speedMbps >= 50) return 1000;
  return 500;
}

export interface UsageListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the FE is allowed to sort on (camelCase key → accessor on UsageResponse).
// Unknown/absent key falls back to `customerName asc` — never throws.
const USAGE_SORT_WHITELIST = new Set(['customerName', 'quotaGb', 'usedGb'] as const);

type SortableKey = 'customerName' | 'quotaGb' | 'usedGb';

function isSortableKey(key: string | undefined): key is SortableKey {
  return key !== undefined && USAGE_SORT_WHITELIST.has(key as SortableKey);
}

@Injectable()
export class UsageService {
  constructor(private readonly customers: CustomersRepository) {}

  /**
   * Compute the data-usage list for all provisioned subscribers. usedGb +
   * trend are synthesised deterministically per row (a real deployment
   * would read these from RADIUS accounting) — no usage table is stored.
   *
   * Applies q (ILIKE substring on customerName/planName), sort/order
   * (whitelist: customerName, quotaGb, usedGb; default: customerName asc),
   * and limit/offset for server-side pagination. The summary is always
   * computed over the FULL computed set before any filtering.
   */
  async list(
    filter: UsageListFilter,
  ): Promise<{ items: UsageResponse[]; total: number; summary: UsageSummary }> {
    // Step 1: build the full computed set (deterministic, ordered by customerName asc
    // from the repo — the natural order of findForUsage).
    const all = await this.buildAll();

    // Step 2: full-set summary — computed over ALL rows, BEFORE any q/paging filter.
    // This is the invariant: the summary never changes regardless of search or paging.
    const totalUsedGb = all.reduce((acc, r) => acc + r.usedGb, 0);
    const throttled = all.filter((r) => r.fupThrottled).length;
    const avgUsedGb = all.length > 0 ? Math.round(totalUsedGb / all.length) : 0;
    const summary: UsageSummary = { totalUsedGb, throttled, avgUsedGb };

    // Step 3: apply q filter (case-insensitive substring on customerName and planName).
    const q = filter.q?.toLowerCase();
    const filtered = q
      ? all.filter(
          (r) => r.customerName.toLowerCase().includes(q) || r.planName.toLowerCase().includes(q),
        )
      : all;

    // Step 4: sort — whitelist enforced; unknown/absent key falls back to customerName asc.
    const sortKey = isSortableKey(filter.sort) ? filter.sort : 'customerName';
    const dir = filter.order === 'desc' ? -1 : 1;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });

    // Step 5: limit/offset paging.
    const items = sorted.slice(filter.offset, filter.offset + filter.limit);

    return { items, total: filtered.length, summary };
  }

  /**
   * A single subscriber's own usage row (portal self-care, P3.C.4). Built
   * from the exact same full computed set as list() — via the shared
   * buildAll() helper — so the number a customer sees on their portal
   * always matches the staff usage table exactly. 404s when the customer
   * id is not in the provisioned set (aktif/isolir).
   */
  async forCustomer(customerId: string): Promise<UsageResponse> {
    const all = await this.buildAll();
    const row = all.find((r) => r.customerId === customerId);
    if (!row) throw new NotFoundException('data pemakaian tidak ditemukan untuk pelanggan ini');
    return row;
  }

  // Builds the full computed usage set, ordered by customerName asc — the
  // natural order of findForUsage(). Shared by list() and forCustomer() so
  // the usedGb/trend synthesis can never drift between the two callers.
  private async buildAll(): Promise<UsageResponse[]> {
    const base = await this.customers.findForUsage();
    return base.map((c, i) => {
      const quotaGb = quotaForSpeed(c.planSpeedMbps);
      const usedGb = quotaGb === 0 ? 300 + i * 40 : Math.round(quotaGb * (0.4 + (i % 7) * 0.12));
      return {
        customerId: c.id,
        customerName: c.fullName,
        planName: c.planName,
        quotaGb,
        usedGb,
        fupThrottled: quotaGb > 0 && usedGb >= quotaGb,
        trend: Array.from({ length: 7 }, (_, d) => 5 + ((i + d) % 9) * 3),
      };
    });
  }
}
