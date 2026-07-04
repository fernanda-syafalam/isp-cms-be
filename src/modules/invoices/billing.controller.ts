import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BillingAutomationService } from './billing-automation.service';
import {
  IsolirResultDto,
  RemindDto,
  RemindResultDto,
  SchedulerPreviewDto,
  SchedulerRunResultDto,
} from './dto/billing-automation.dto';
import { BillingRunResultDto } from './dto/billing-run-result.dto';
import { InvoicesService } from './invoices.service';

// Billing automation: generation + dunning + auto-isolir + scheduler.
@Roles('admin', 'staff')
@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly automation: BillingAutomationService,
  ) {}

  // Generate the current period's invoices for active customers.
  @Roles('admin', 'staff')
  @Audit('billing.run')
  @Post('run')
  @ZodSerializerDto(BillingRunResultDto)
  run() {
    return this.invoices.run();
  }

  // Mark overdue + late fee, then suspend active debtors.
  @Roles('admin', 'staff')
  @Audit('billing.isolir')
  @Post('isolir-overdue')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(IsolirResultDto)
  isolirOverdue() {
    return this.automation.isolirOverdue();
  }

  // Send dunning reminders (explicit ids, or all overdue).
  @Roles('admin', 'staff')
  @Audit('billing.remind')
  @Post('remind')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RemindResultDto)
  remind(@Body() body: RemindDto) {
    return this.automation.remind(body);
  }

  // Read-only forecast of the next automated cycle.
  @Get('scheduler/preview')
  @ZodSerializerDto(SchedulerPreviewDto)
  schedulerPreview() {
    return this.automation.schedulerPreview();
  }

  // Run the full cycle (bill -> overdue -> dun -> isolir).
  @Roles('admin', 'staff')
  @Audit('billing.scheduler')
  @Post('scheduler/run')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SchedulerRunResultDto)
  schedulerRun() {
    return this.automation.schedulerRun();
  }
}
