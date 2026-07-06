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
   * subscribers (isolated or in debt). A resolved ticket rated by the
   * customer (P3.C.2, `ticket.csatRating`/`csatComment`) contributes its
   * real value; only un-rated resolved tickets fall back to the synthetic
   * 3/4/5 cycle used before real CSAT existed (no survey table yet).
   */
  async get(): Promise<SatisfactionResponse> {
    const resolved = await this.tickets.list({
      status: 'resolved',
      limit: FEEDBACK_LIMIT,
      offset: 0,
    });
    const csatCount = resolved.total;
    const ratings = resolved.items.map((t, i) => t.csatRating ?? syntheticRating(i));
    const csatAvg =
      ratings.length > 0 ? round1(ratings.reduce((sum, r) => sum + r, 0) / ratings.length) : 0;

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
      rating: t.csatRating ?? syntheticRating(i),
      comment: t.csatComment ?? COMMENTS[i % COMMENTS.length] ?? 'Terima kasih',
      at: t.csatAt ?? t.createdAt,
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

// Deterministic fallback for a resolved ticket the customer never rated —
// cycles 3,4,5 by position so the placeholder is stable across reloads.
function syntheticRating(index: number): number {
  return 3 + (index % 3);
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
