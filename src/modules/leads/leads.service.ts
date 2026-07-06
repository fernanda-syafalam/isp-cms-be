import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Lead } from '../../infrastructure/database/schema/leads.schema';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PlansRepository } from '../plans/plans.repository';
import type { CreateLeadInput } from './dto/create-lead.dto';
import type { LeadResponse } from './dto/lead-response.dto';
import type { UpdateLeadStageInput } from './dto/update-lead-stage.dto';
import { type LeadListFilter, LeadsRepository } from './leads.repository';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly repo: LeadsRepository,
    // Conversion delegates to the single onboarding acquisition path
    // (P3.A.2); it only resolves the plan FK by name itself.
    private readonly onboarding: OnboardingService,
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
      resellerId: input.resellerId ?? null,
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

    // One acquisition path (P3.A.2): onboarding creates the `instalasi`
    // subscriber (provisioning a portal login when there's an email) and
    // schedules the linked install WO, so a converted lead and a wizard
    // customer are identical downstream — the activation cascade runs on
    // completion (ADR-0009).
    await this.onboarding.onboardFromLead({
      fullName: lead.name,
      phone: lead.phone,
      address: lead.address,
      areaName: lead.areaName,
      planId: plan.id,
      // Propagate the lead's acquisition channel (P3.D.2) so the resulting
      // customer keeps the same reseller attribution.
      resellerId: lead.resellerId,
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
    resellerId: row.resellerId,
    createdAt: row.createdAt.toISOString(),
  };
}
