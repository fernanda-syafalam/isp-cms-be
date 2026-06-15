import { Injectable } from '@nestjs/common';
import { CustomersRepository } from '../customers/customers.repository';
import type { UsageResponse } from './dto/usage-response.dto';

// Quota derived from plan speed: >=100 Mbps unlimited, >=50 -> 1000 GB,
// else 500 GB. Matches the FE contract.
function quotaForSpeed(speedMbps: number): number {
  if (speedMbps >= 100) return 0;
  if (speedMbps >= 50) return 1000;
  return 500;
}

@Injectable()
export class UsageService {
  constructor(private readonly customers: CustomersRepository) {}

  /**
   * Compute the data-usage list for all provisioned subscribers. usedGb +
   * trend are synthesised deterministically per row (a real deployment
   * would read these from RADIUS accounting) — no usage table is stored.
   */
  async list(): Promise<{ items: UsageResponse[]; total: number }> {
    const base = await this.customers.findForUsage();
    const items: UsageResponse[] = base.map((c, i) => {
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
    return { items, total: items.length };
  }
}
