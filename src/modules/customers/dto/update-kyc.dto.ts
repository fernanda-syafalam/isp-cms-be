import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for PATCH /v1/customers/:id/kyc. Captures the subscriber's
 * national ID (KTP/NIK) and, optionally, tax number (NPWP). An empty
 * `npwp` string clears it (normalised to null in the service).
 */
export const UpdateKycSchema = z
  .object({
    ktp: z.string().trim().min(1).max(32),
    npwp: z.union([z.string().trim().max(40), z.literal('')]).optional(),
  })
  .strict();

export type UpdateKycInput = z.infer<typeof UpdateKycSchema>;

export class UpdateKycDto extends createZodDto(UpdateKycSchema) {}
