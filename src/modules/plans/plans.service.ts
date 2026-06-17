import { Injectable, Logger } from '@nestjs/common';
import type { Plan } from '../../infrastructure/database/schema/plans.schema';
import type { CreatePlanInput } from './dto/create-plan.dto';
import type { UpdatePlanInput } from './dto/update-plan.dto';
import { type PlanListFilter, PlansRepository } from './plans.repository';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly repo: PlansRepository) {}

  async list(filter: PlanListFilter): Promise<{ items: Plan[]; total: number }> {
    return this.repo.list(filter);
  }

  async create(input: CreatePlanInput): Promise<Plan> {
    const plan = await this.repo.create(input);
    this.logger.log({ planId: plan.id }, 'plan created');
    return plan;
  }

  async update(id: string, input: UpdatePlanInput): Promise<Plan> {
    const plan = await this.repo.update(id, input);
    this.logger.log({ planId: plan.id }, 'plan updated');
    return plan;
  }

  async archive(id: string): Promise<Plan> {
    const plan = await this.repo.archive(id);
    this.logger.log({ planId: plan.id }, 'plan archived');
    return plan;
  }
}
