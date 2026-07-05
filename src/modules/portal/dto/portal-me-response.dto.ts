import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CustomerResponseSchema } from '../../customers/dto/customer-response.dto';
import { InvoiceResponseSchema } from '../../invoices/dto/invoice-response.dto';
import { PaymentIntentResponseSchema } from '../../invoices/dto/payment-intent-response.dto';
import { PaymentResponseSchema } from '../../invoices/dto/payment-response.dto';
import { TicketResponseSchema } from '../../tickets/dto/ticket-response.dto';

/**
 * The authenticated customer's self-service snapshot — mirrors the FE
 * `PortalMeSchema`. Composed from the existing per-module response schemas
 * so the portal never re-declares those shapes.
 */
export const PortalMeResponseSchema = z.object({
  customer: CustomerResponseSchema,
  invoices: z.array(InvoiceResponseSchema),
  payments: z.array(PaymentResponseSchema),
  tickets: z.array(TicketResponseSchema),
  // Still-resumable pay-intents (P3.C.3): unpaid QRIS/VA the FE can offer to
  // resume instead of discarding on dialog close. Ownership is enforced in
  // the repository join, never in this DTO.
  pendingIntents: z.array(PaymentIntentResponseSchema),
});

export type PortalMeResponse = z.infer<typeof PortalMeResponseSchema>;

export class PortalMeResponseDto extends createZodDto(PortalMeResponseSchema) {}
