import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CustomerResponseSchema } from '../../customers/dto/customer-response.dto';

/**
 * Output of POST /v1/onboarding: the new customer plus the provisioned
 * portal login (P1.3). `portalLogin` is null when the wizard had no email
 * or the email already belongs to a user. The initial password appears
 * ONCE, here — it is never readable again (staff communicate it to the
 * subscriber until P2 notifications deliver a set-password link).
 */
export const OnboardResponseSchema = CustomerResponseSchema.extend({
  portalLogin: z
    .object({
      email: z.email(),
      initialPassword: z.string(),
    })
    .nullable(),
});

export type OnboardResponse = z.infer<typeof OnboardResponseSchema>;

export class OnboardResponseDto extends createZodDto(OnboardResponseSchema) {}
