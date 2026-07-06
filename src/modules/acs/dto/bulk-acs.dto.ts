import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Shared WiFi credential constraints — reused by the bulk staff action
// (this file) and the portal self-care seam (acs/dto/set-wifi.dto.ts), so
// the two never drift apart.
export const WifiSsidSchema = z.string().trim().min(1).max(32);
export const WifiPasswordSchema = z.string().min(8).max(63);

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
    ssid: WifiSsidSchema.optional(),
    password: WifiPasswordSchema.optional(),
  })
  .strict();

export type BulkAcsInput = z.infer<typeof BulkAcsSchema>;

export class BulkAcsDto extends createZodDto(BulkAcsSchema) {}
