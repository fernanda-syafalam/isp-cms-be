import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for GET /v1/portal/wifi — the caller's own CPE WiFi identity. */
export const WifiResponseSchema = z.object({
  serial: z.string(),
  model: z.string(),
  // Null until the first setWifi call — the seeded fixture never sets it.
  ssid: z.string().nullable(),
});

export type WifiResponse = z.infer<typeof WifiResponseSchema>;
export class WifiResponseDto extends createZodDto(WifiResponseSchema) {}

/** Output shape for POST /v1/portal/wifi — ack + the ssid now in effect. */
export const SetWifiResultSchema = z.object({
  ok: z.literal(true),
  ssid: z.string(),
});

export type SetWifiResult = z.infer<typeof SetWifiResultSchema>;
export class SetWifiResultDto extends createZodDto(SetWifiResultSchema) {}
