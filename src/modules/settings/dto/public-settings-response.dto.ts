import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * SEC-3: the invoice-needed subset of settings — company identity + the
 * tax fields a FAKTUR/KWITANSI must show (PKP flag, NPWP, PPN rate). Any
 * authenticated role (including `customer`) may read this; everything
 * else in the full settings blob (billing policy: late fee, due days,
 * isolir grace days) is operational config and stays admin-only behind
 * `GET /v1/settings`. See `SettingsController` for the split rationale.
 */
export const PublicSettingsResponseSchema = z.object({
  company: z.object({
    name: z.string(),
    address: z.string(),
    phone: z.string(),
    email: z.string(),
  }),
  tax: z.object({
    pkp: z.boolean(),
    npwp: z.string(),
    ppnRate: z.number().nonnegative(),
  }),
});

export type PublicSettingsResponse = z.infer<typeof PublicSettingsResponseSchema>;

export class PublicSettingsResponseDto extends createZodDto(PublicSettingsResponseSchema) {}
