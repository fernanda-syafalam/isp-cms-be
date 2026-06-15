import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for PATCH /v1/devices/:id — operator-correctable fields. */
export const UpdateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ipAddress: z.string().trim().min(1).max(60).optional(),
    areaName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type UpdateDeviceInput = z.infer<typeof UpdateDeviceSchema>;
export class UpdateDeviceDto extends createZodDto(UpdateDeviceSchema) {}
