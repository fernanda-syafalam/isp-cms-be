import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a TR-069 managed device. */
export const AcsDeviceResponseSchema = z.object({
  id: z.uuid(),
  serial: z.string(),
  customerName: z.string(),
  model: z.string(),
  firmware: z.string(),
  rxPowerDbm: z.number().nullable(),
  status: z.enum(['online', 'offline']),
  lastInform: z.iso.datetime(),
});

export type AcsDeviceResponse = z.infer<typeof AcsDeviceResponseSchema>;
export class AcsDeviceResponseDto extends createZodDto(AcsDeviceResponseSchema) {}

/** Result of a bulk action — how many devices were affected. */
export const BulkAcsResultSchema = z.object({
  affected: z.number().int().nonnegative(),
});

export type BulkAcsResult = z.infer<typeof BulkAcsResultSchema>;
export class BulkAcsResultDto extends createZodDto(BulkAcsResultSchema) {}
