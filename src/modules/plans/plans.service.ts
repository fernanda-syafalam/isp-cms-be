import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import type { Plan } from '../../infrastructure/database/schema/plans.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { CreatePlanInput } from './dto/create-plan.dto';
import type { PlanListResponse } from './dto/plan-response.dto';
import type { UpdatePlanInput } from './dto/update-plan.dto';
import { type PlanListFilter, PlansRepository } from './plans.repository';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly repo: PlansRepository,
    // Only used to enrich the list summary with `totalSubscribers` (active
    // customer count across the whole base) — CustomersModule imports
    // PlansModule (plan FK validation), so this edge needs forwardRef() on
    // both sides (see plans.module.ts / customers.module.ts).
    @Inject(forwardRef(() => CustomersRepository))
    private readonly customers: CustomersRepository,
  ) {}

  async list(filter: PlanListFilter): Promise<PlanListResponse> {
    const [{ items, total, summary }, statusCounts] = await Promise.all([
      this.repo.list(filter),
      this.customers.countByStatus(),
    ]);
    return {
      items,
      total,
      summary: { ...summary, totalSubscribers: statusCounts.aktif },
    };
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
