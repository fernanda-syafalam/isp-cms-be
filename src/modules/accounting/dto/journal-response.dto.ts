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

/** Output shape for the period journal (double-entry, debit == credit). */
export const JournalResponseSchema = z.object({
  period: z.string(),
  lines: z.array(JournalLineSchema),
  totals: z.object({
    debit: z.number().int().nonnegative(),
    credit: z.number().int().nonnegative(),
  }),
});

export type JournalLine = z.infer<typeof JournalLineSchema>;
export type JournalResponse = z.infer<typeof JournalResponseSchema>;

export class JournalResponseDto extends createZodDto(JournalResponseSchema) {}
