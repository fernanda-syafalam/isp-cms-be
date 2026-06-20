import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Lead } from '../../infrastructure/database/schema/leads.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { PlansRepository } from '../plans/plans.repository';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { CreateLeadInput } from './dto/create-lead.dto';
import type { LeadResponse } from './dto/lead-response.dto';
import type { UpdateLeadStageInput } from './dto/update-lead-stage.dto';
import { type LeadListFilter, LeadsRepository } from './leads.repository';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly repo: LeadsRepository,
    // Conversion creates a subscriber (CustomersRepository), schedules an
    // install (WorkOrdersService) and resolves the plan FK by name.
    private readonly customers: CustomersRepository,
    private readonly workOrders: WorkOrdersService,
    private readonly plans: PlansRepository,
  ) {}

  async list(filter: LeadListFilter): Promise<{ items: LeadResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toLeadResponse), total };
  }

  async create(input: CreateLeadInput): Promise<LeadResponse> {
    const lead = await this.repo.create({
      name: input.name,
      phone: input.phone,
      address: input.address,
      areaName: input.areaName,
      planName: input.planName,
      estValue: input.estValue,
      source: input.source,
      note: input.note ?? null,
    });
    this.logger.log({ leadId: lead.id }, 'lead created');
    return toLeadResponse(lead);
  }

  async updateStage(id: string, input: UpdateLeadStageInput): Promise<LeadResponse> {
    const lead = await this.repo.setStage(id, input.stage);
    return toLeadResponse(lead);
  }

  /**
   * Convert a won lead into a subscriber + scheduled install. Idempotent:
   * a lead already at `won` is returned without creating duplicates.
   */
  async convert(id: string): Promise<LeadResponse> {
    const lead = await this.repo.findById(id);
    if (!lead) throw new NotFoundException('lead not found');
    if (lead.stage === 'won') {
      return toLeadResponse(lead);
    }

    const plan = await this.plans.findByName(lead.planName);
    if (!plan) {
      throw new BadRequestException('plan not found for lead');
    }

    const customer = await this.customers.create({
      fullName: lead.name,
      phone: lead.phone,
      address: lead.address,
      areaName: lead.areaName,
      planId: plan.id,
      // New subscriber starts at installation, not active.
      status: 'instalasi',
    });
    // Link the install order to the new subscriber so completing it activates,
    // provisions, and bills them. Passing only the name left customerId null
    // and the activation cascade was silently skipped (ADR-0009).
    await this.workOrders.scheduleInstall({
      customerId: customer.id,
      customerName: customer.fullName,
    });

    const won = await this.repo.setStage(id, 'won');
    this.logger.log({ leadId: id }, 'lead converted');
    return toLeadResponse(won);
  }
}

function toLeadResponse(row: Lead): LeadResponse {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    areaName: row.areaName,
    planName: row.planName,
    stage: row.stage,
    estValue: row.estValue,
    source: row.source,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
