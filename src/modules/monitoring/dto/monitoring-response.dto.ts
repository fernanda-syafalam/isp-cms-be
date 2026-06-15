import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a device-health metric. */
export const DeviceMetricResponseSchema = z.object({
  deviceId: z.uuid(),
  name: z.string(),
  type: z.string(),
  areaName: z.string(),
  status: z.enum(['up', 'degraded', 'down']),
  uptimePct: z.number(),
  latencyMs: z.number().int().nonnegative(),
  utilizationPct: z.number().int().nonnegative(),
});

export type DeviceMetricResponse = z.infer<typeof DeviceMetricResponseSchema>;
export class DeviceMetricResponseDto extends createZodDto(DeviceMetricResponseSchema) {}

/** Output shape for a NOC alert. */
export const AlertResponseSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  deviceName: z.string(),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
  at: z.iso.datetime(),
  acknowledged: z.boolean(),
});

export type AlertResponse = z.infer<typeof AlertResponseSchema>;
export class AlertResponseDto extends createZodDto(AlertResponseSchema) {}
