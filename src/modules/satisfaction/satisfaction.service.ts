import { Injectable } from '@nestjs/common';
import { CustomersRepository } from '../customers/customers.repository';
import { TicketsService } from '../tickets/tickets.service';
import type { SatisfactionResponse } from './dto/satisfaction-response.dto';

const COMMENTS = [
  'Pemasangan cepat dan rapi',
  'Sinyal stabil, puas',
  'Sempat gangguan tapi cepat ditangani',
  'Pelayanan ramah',
  'Kurang puas saat isolir',
];
const FEEDBACK_LIMIT = 6;
const AT_RISK_LIMIT = 6;

@Injectable()
export class SatisfactionService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly tickets: TicketsService,
  ) {}

  /**
   * Aggregate satisfaction summary. CSAT + recent feedback derive from
   * resolved tickets; NPS from the subscriber count; churn from at-risk
   * subscribers (isolated or in debt). Ratings/NPS scores are synthesised
   * deterministically (no survey table yet) — matches the FE contract.
   */
  async get(): Promise<SatisfactionResponse> {
    const resolved = await this.tickets.list({
      status: 'resolved',
      limit: FEEDBACK_LIMIT,
      offset: 0,
    });
    const csatCount = resolved.total;
    const csatAvg = csatCount > 0 ? round1(sumSyntheticRatings(csatCount) / csatCount) : 0;

    const total = await this.customers.countAll();
    const nps = computeNps(total);

    const atRiskRows = await this.customers.findAtRisk(AT_RISK_LIMIT);
    const atRisk = atRiskRows.map((c) => ({
      customerId: c.id,
      customerName: c.fullName,
      reason: c.status === 'isolir' ? 'Terisolir' : 'Tunggakan tagihan',
      riskPct: c.status === 'isolir' ? 80 : 55,
    }));
    const churnRate = total > 0 ? round1((atRisk.length / total) * 100) : 0;

    const recentFeedback = resolved.items.map((t, i) => ({
      id: `${t.id}-fb`,
      ...(t.customerId ? { customerId: t.customerId } : {}),
      customerName: t.customerName,
      rating: 3 + (i % 3),
      comment: COMMENTS[i % COMMENTS.length] ?? 'Terima kasih',
      at: t.createdAt,
    }));

    return {
      csat: { avg: csatAvg, count: csatCount },
      nps,
      churn: { rate: churnRate, atRisk },
      recentFeedback,
    };
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Resolved-ticket ratings cycle 3,4,5 — sum without materialising the array.
function sumSyntheticRatings(count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += 3 + (i % 3);
  return sum;
}

// NPS scores cycle 0..10 per subscriber index; classify and score.
function computeNps(total: number): SatisfactionResponse['nps'] {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (let i = 0; i < total; i += 1) {
    const score = (i * 7) % 11;
    if (score >= 9) promoters += 1;
    else if (score >= 7) passives += 1;
    else detractors += 1;
  }
  const score = total > 0 ? Math.round((promoters / total) * 100 - (detractors / total) * 100) : 0;
  return { score, promoters, passives, detractors, total };
}
