import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a lead (pipeline card). */
export const LeadResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  address: z.string(),
  areaName: z.string(),
  planName: z.string(),
  stage: z.enum(['new', 'survey', 'quote', 'won', 'lost']),
  estValue: z.number().int().nonnegative(),
  source: z.enum(['walk_in', 'referral', 'online', 'reseller']),
  note: z.string().nullable(),
  // Acquisition channel (P3.D.2): which reseller/mitra brought this lead.
  resellerId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type LeadResponse = z.infer<typeof LeadResponseSchema>;

export class LeadResponseDto extends createZodDto(LeadResponseSchema) {}
