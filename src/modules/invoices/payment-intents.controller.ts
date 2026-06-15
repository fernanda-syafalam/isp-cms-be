import { Body, Controller, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { PaymentIntentResponseDto } from './dto/payment-intent-response.dto';
import { PaymentIntentsService } from './payment-intents.service';

// Online gateway charges (QRIS / VA / e-wallet). Coexists with the read-only
// PaymentsController (`GET /v1/payments`) — distinct routes, no conflict.
@Controller({ path: 'payments', version: '1' })
export class PaymentIntentsController {
  constructor(private readonly intents: PaymentIntentsService) {}

  // Open a gateway charge for an invoice — returns a VA number or QR payload.
  @Roles('admin', 'staff')
  @Audit('payment.intent.create')
  @Post('intent')
  @ZodSerializerDto(PaymentIntentResponseDto)
  create(@Body() body: CreatePaymentIntentDto) {
    return this.intents.create(body);
  }

  // Simulate the gateway settlement webhook: settle the invoice + mark paid.
  @Roles('admin', 'staff')
  @Audit('payment.intent.confirm')
  @Post('intent/:id/confirm')
  @ZodSerializerDto(PaymentIntentResponseDto)
  confirm(@Param('id') id: string) {
    return this.intents.confirm(id);
  }
}
