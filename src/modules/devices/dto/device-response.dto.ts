import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A single managed device — mirrors the FE `DeviceSchema`. */
export const DeviceResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['olt', 'onu', 'mikrotik']),
  ipAddress: z.string(),
  status: z.enum(['online', 'degraded', 'offline']),
  uptimeHours: z.number().nonnegative(),
  rxPower: z.number().nullable(),
  areaName: z.string(),
  lastSeenAt: z.iso.datetime(),
  topologyNodeId: z.string().nullable(),
});
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;
export class DeviceResponseDto extends createZodDto(DeviceResponseSchema) {}

export const DeviceListResponseSchema = z.object({
  items: z.array(DeviceResponseSchema),
  total: z.number().int().nonnegative(),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export class DeviceListResponseDto extends createZodDto(DeviceListResponseSchema) {}
