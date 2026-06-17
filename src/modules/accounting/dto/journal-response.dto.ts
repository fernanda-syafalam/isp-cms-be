import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const JournalLineSchema = z.object({
  id: z.string(),
  date: z.iso.datetime(),
  accountCode: z.string(),
  accountName: z.string(),
  description: z.string(),
  debit: z.number().int().nonnegative(),
  credit: z.number().int().nonnegative(),
});

/**
 * Output shape for the period journal (double-entry, debit == credit).
 *
 * - `lines`  – the current page of posting lines (after q-filter + sort + limit/offset).
 * - `total`  – count of lines matching the q-filter BEFORE limit/offset (for page-count math).
 * - `totals` – full-period debit/credit aggregate; NEVER affected by q/limit/offset.
 */
export const JournalResponseSchema = z.object({
  period: z.string(),
  lines: z.array(JournalLineSchema),
  total: z.number().int().nonnegative(),
  totals: z.object({
    debit: z.number().int().nonnegative(),
    credit: z.number().int().nonnegative(),
  }),
});

export type JournalLine = z.infer<typeof JournalLineSchema>;
export type JournalResponse = z.infer<typeof JournalResponseSchema>;

export class JournalResponseDto extends createZodDto(JournalResponseSchema) {}
