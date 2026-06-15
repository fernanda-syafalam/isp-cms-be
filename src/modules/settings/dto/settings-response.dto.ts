import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for the settings singleton (nested by section). */
export const SettingsResponseSchema = z.object({
  company: z.object({
    name: z.string(),
    address: z.string(),
    phone: z.string(),
    email: z.string(),
  }),
  billing: z.object({
    lateFeeIdr: z.number().int().nonnegative(),
    dueDays: z.number().int().positive(),
    isolirGraceDays: z.number().int().nonnegative(),
  }),
  tax: z.object({
    pkp: z.boolean(),
    npwp: z.string(),
    ppnRate: z.number().nonnegative(),
  }),
});

export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export class SettingsResponseDto extends createZodDto(SettingsResponseSchema) {}
