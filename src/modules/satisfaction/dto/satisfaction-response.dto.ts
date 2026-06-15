import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const AtRiskSchema = z.object({
  customerId: z.uuid().optional(),
  customerName: z.string(),
  reason: z.string(),
  riskPct: z.number().int().min(0).max(100),
});

const FeedbackSchema = z.object({
  id: z.string(),
  customerId: z.uuid().optional(),
  customerName: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string(),
  at: z.iso.datetime(),
});

/** Aggregated customer-satisfaction summary (CSAT / NPS / churn / feedback). */
export const SatisfactionResponseSchema = z.object({
  csat: z.object({
    avg: z.number(),
    count: z.number().int().nonnegative(),
  }),
  nps: z.object({
    score: z.number().int(),
    promoters: z.number().int().nonnegative(),
    passives: z.number().int().nonnegative(),
    detractors: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  churn: z.object({
    rate: z.number(),
    atRisk: z.array(AtRiskSchema),
  }),
  recentFeedback: z.array(FeedbackSchema),
});

export type SatisfactionResponse = z.infer<typeof SatisfactionResponseSchema>;

export class SatisfactionResponseDto extends createZodDto(SatisfactionResponseSchema) {}
