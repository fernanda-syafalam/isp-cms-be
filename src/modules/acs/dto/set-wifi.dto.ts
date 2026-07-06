import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WifiPasswordSchema, WifiSsidSchema } from './bulk-acs.dto';

/**
 * Input for POST /v1/portal/wifi — change the caller's own CPE WiFi
 * SSID/password. Same ssid(<=32)/password(8-63) constraints as the staff
 * bulk-wifi action (single source of truth).
 */
export const SetWifiSchema = z
  .object({
    ssid: WifiSsidSchema,
    password: WifiPasswordSchema,
  })
  .strict();

export type SetWifiInput = z.infer<typeof SetWifiSchema>;
export class SetWifiDto extends createZodDto(SetWifiSchema) {}
