import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PaymentChannelSchema = z.enum([
  'qris',
  'va_bca',
  'va_mandiri',
  'va_bri',
  'va_bni',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
]);

export const PaymentIntentStatusSchema = z.enum(['pending', 'paid', 'expired']);

/** A gateway charge — mirrors the FE `PaymentIntentSchema`. */
export const PaymentIntentResponseSchema = z.object({
  id: z.string(),
  invoiceId: z.uuid(),
  invoiceNo: z.string(),
  customerName: z.string(),
  amount: z.number().int().nonnegative(),
  channel: PaymentChannelSchema,
  status: PaymentIntentStatusSchema,
  vaNumber: z.string().nullable(),
  qrPayload: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
});

export type PaymentIntentResponse = z.infer<typeof PaymentIntentResponseSchema>;
export class PaymentIntentResponseDto extends createZodDto(PaymentIntentResponseSchema) {}
