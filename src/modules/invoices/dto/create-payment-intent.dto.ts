import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaymentChannelSchema } from './payment-intent-response.dto';

/** Input for POST /v1/payments/intent — mirrors FE `CreatePaymentIntentSchema`. */
export const CreatePaymentIntentSchema = z
  .object({
    invoiceId: z.string().min(1),
    channel: PaymentChannelSchema,
  })
  .strict();

export type CreatePaymentIntentInput = z.infer<typeof CreatePaymentIntentSchema>;
export class CreatePaymentIntentDto extends createZodDto(CreatePaymentIntentSchema) {}
