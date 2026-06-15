import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Mirror of the FE OdpRecordSchema (src/schemas/odp.ts).
export const OdpRecordResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  area: z.string(),
  splitter: z.string(),
  totalPorts: z.number().int().positive(),
  usedPorts: z.number().int().nonnegative(),
  avgRxPowerDbm: z.number(),
  status: z.enum(['healthy', 'warning', 'critical']),
});

export const OdpListResponseSchema = z.object({
  items: z.array(OdpRecordResponseSchema),
  total: z.number().int().nonnegative(),
});

export type OdpRecordResponse = z.infer<typeof OdpRecordResponseSchema>;
export type OdpListResponse = z.infer<typeof OdpListResponseSchema>;

export class OdpListResponseDto extends createZodDto(OdpListResponseSchema) {}
