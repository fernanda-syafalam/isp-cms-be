import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/customers/:id/relocate. */
export const RelocateSchema = z
  .object({
    address: z.string().trim().min(1).max(255),
    areaName: z.string().trim().min(1).max(120),
  })
  .strict();
export type RelocateInput = z.infer<typeof RelocateSchema>;
export class RelocateDto extends createZodDto(RelocateSchema) {}

/** Input for POST /v1/customers/:id/onu/wifi. */
export const SetOnuWifiSchema = z
  .object({
    ssid: z.string().trim().min(1).max(32),
    password: z.string().min(8).max(63),
  })
  .strict();
export type SetOnuWifiInput = z.infer<typeof SetOnuWifiSchema>;
export class SetOnuWifiDto extends createZodDto(SetOnuWifiSchema) {}

/** Input for POST /v1/customers/:id/change-plan. */
export const ChangePlanSchema = z
  .object({
    planId: z.uuid(),
  })
  .strict();
export type ChangePlanInput = z.infer<typeof ChangePlanSchema>;
export class ChangePlanDto extends createZodDto(ChangePlanSchema) {}
