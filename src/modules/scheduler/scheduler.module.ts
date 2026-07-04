import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { TicketsModule } from '../tickets/tickets.module';
import { SCHEDULER_QUEUE } from './scheduler.constants';
import { SchedulerProcessor } from './scheduler.processor';
import { SchedulerService } from './scheduler.service';

/**
 * Automation backbone (P2.1). Registers the `scheduler` queue; SchedulerService
 * upserts the repeatable jobs on boot and SchedulerProcessor runs each tick by
 * calling the owning domain service. InvoicesModule exports the billing /
 * invoice / payment-intent services; TicketsModule exports the ticket service.
 */
@Module({
  imports: [BullModule.registerQueue({ name: SCHEDULER_QUEUE }), InvoicesModule, TicketsModule],
  providers: [SchedulerService, SchedulerProcessor],
})
export class SchedulerModule {}
