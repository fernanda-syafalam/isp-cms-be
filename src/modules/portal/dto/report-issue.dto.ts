import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/portal/tickets — a customer reports a problem. Mirrors
 * the FE `ReportIssueSchema`; the max is capped at the ticket `subject`
 * column length (160), which the FE's looser 200 never exceeds in practice.
 */
export const ReportIssueSchema = z
  .object({
    subject: z.string().trim().min(5).max(160),
  })
  .strict();

export type ReportIssueInput = z.infer<typeof ReportIssueSchema>;

export class ReportIssueDto extends createZodDto(ReportIssueSchema) {}
