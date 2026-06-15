import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/acs/bulk. One endpoint for all CPE actions:
 * - reboot: deviceIds only
 * - firmware: deviceIds + firmwareVersion
 * - wifi: deviceIds + ssid + password
 * Per-action requirements are enforced in the service.
 */
export const BulkAcsSchema = z
  .object({
    action: z.enum(['reboot', 'firmware', 'wifi']),
    deviceIds: z.array(z.uuid()).min(1),
    firmwareVersion: z.string().trim().min(1).max(40).optional(),
    ssid: z.string().trim().min(1).max(32).optional(),
    password: z.string().min(8).max(63).optional(),
  })
  .strict();

export type BulkAcsInput = z.infer<typeof BulkAcsSchema>;

export class BulkAcsDto extends createZodDto(BulkAcsSchema) {}
