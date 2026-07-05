import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/work-orders/:id/complete — optional field-completion
 * evidence captured by the technician (P3.B.3): scanned ONU serial, measured
 * RX power, photos, signature, GPS. Every field is optional so completion
 * still works without a field kit (matches the existing degrade-gracefully
 * contract for the install cascade).
 */
export const CompleteWorkOrderSchema = z
  .object({
    onuSerial: z.string().trim().min(1).max(64).optional(),
    rxPower: z.coerce.number().optional(),
    // Evidence photo URLs/refs — no upload endpoint in scope yet.
    photos: z.array(z.string().url()).max(10).optional(),
    signatureUrl: z.string().url().optional(),
    gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
    technician: z.string().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type CompleteWorkOrderInput = z.infer<typeof CompleteWorkOrderSchema>;

export class CompleteWorkOrderDto extends createZodDto(CompleteWorkOrderSchema) {}
