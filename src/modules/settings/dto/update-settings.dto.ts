import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Each section is optional, but fully specified when present (matches the FE).
const CompanySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(255),
    phone: z.string().trim().max(40),
    email: z.string().trim().max(120),
  })
  .strict();

const BillingSchema = z
  .object({
    lateFeeIdr: z.number().int().nonnegative().max(10_000_000),
    dueDays: z.number().int().positive().max(60),
    isolirGraceDays: z.number().int().nonnegative().max(60),
  })
  .strict();

const TaxSchema = z
  .object({
    pkp: z.boolean(),
    npwp: z.string().trim().max(40),
    ppnRate: z.number().nonnegative().max(1),
  })
  .strict();

/** Input for PATCH /v1/settings — partial per section. */
export const UpdateSettingsSchema = z
  .object({
    company: CompanySchema.optional(),
    billing: BillingSchema.optional(),
    tax: TaxSchema.optional(),
  })
  .strict();

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

export class UpdateSettingsDto extends createZodDto(UpdateSettingsSchema) {}
