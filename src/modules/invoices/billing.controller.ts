import { Controller, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BillingRunResultDto } from './dto/billing-run-result.dto';
import { InvoicesService } from './invoices.service';

// Billing automation. Only the generation step lands in this module for
// now; dunning, auto-isolir and the scheduler arrive with the settings +
// notifications modules.
@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(private readonly invoices: InvoicesService) {}

  // Generate the current period's invoices for active customers.
  @Roles('admin', 'staff')
  @Audit('billing.run')
  @Post('run')
  @ZodSerializerDto(BillingRunResultDto)
  run() {
    return this.invoices.run();
  }
}
