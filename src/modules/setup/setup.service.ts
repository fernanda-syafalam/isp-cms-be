import { Injectable } from '@nestjs/common';
import { BranchesRepository } from '../branches/branches.repository';
import { CustomersRepository } from '../customers/customers.repository';
import { PlansRepository } from '../plans/plans.repository';
import { PoolsRepository } from '../router-resources/pools.repository';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { RoutersRepository } from '../routers/routers.repository';
import { SettingsService } from '../settings/settings.service';
import { UsersRepository } from '../users/users.repository';
import { WorkOrdersRepository } from '../work-orders/work-orders.repository';
import type { SetupStatus } from './dto/setup-status-response.dto';

// A staff/admin team is "configured" once there is more than the bootstrap
// admin alone — see UsersRepository.countByRoles doc comment.
const MIN_STAFF_COUNT = 1;

/**
 * Read-only cross-module rollup for the operator first-run checklist
 * (P3.E.2, docs/FLOWS.md §3.1). Owns no table: every `done` flag is derived
 * per request from the plans / routers / router-resources / branches /
 * settings / users / customers / work-orders repositories (each the sole
 * owner of its table, Pilar 3).
 *
 * This replaces a dishonest FE-only checklist that faked "profiles & pools
 * configured" as `routerCount > 0` — every flag here reads the real table
 * it claims to describe.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly plans: PlansRepository,
    private readonly routers: RoutersRepository,
    private readonly profiles: ProfilesRepository,
    private readonly pools: PoolsRepository,
    private readonly branches: BranchesRepository,
    private readonly settings: SettingsService,
    private readonly users: UsersRepository,
    private readonly customers: CustomersRepository,
    private readonly workOrders: WorkOrdersRepository,
  ) {}

  async getStatus(): Promise<SetupStatus> {
    const [
      plansPage,
      routersPage,
      profilesCount,
      poolsCount,
      branchesPage,
      settingsResponse,
      staffCount,
      statusCounts,
      installDonePage,
    ] = await Promise.all([
      this.plans.list({ limit: 1, offset: 0 }),
      this.routers.list({ limit: 1, offset: 0 }),
      this.profiles.countAll(),
      this.pools.countAll(),
      this.branches.list({ limit: 1, offset: 0 }),
      this.settings.get(),
      this.users.countByRoles(['admin', 'staff']),
      this.customers.countByStatus(),
      this.workOrders.list({ type: 'install', status: 'done', limit: 1, offset: 0 }),
    ]);

    const plansCount = plansPage.total;
    const routersCount = routersPage.total;
    const branchesCount = branchesPage.total;
    const companyName = settingsResponse.company.name;
    const instalasiCount = statusCounts.instalasi;
    const aktifCount = statusCounts.aktif;
    const installDoneCount = installDonePage.total;

    return {
      catalogue: { done: plansCount > 0, plansCount },
      network: {
        done: routersCount > 0 && profilesCount > 0 && poolsCount > 0,
        routersCount,
        profilesCount,
        poolsCount,
      },
      branches: { done: branchesCount > 0, branchesCount },
      settings: { done: companyName.trim().length > 0, companyName },
      staff: { done: staffCount > MIN_STAFF_COUNT, staffCount },
      onboarding: {
        done: instalasiCount > 0 || aktifCount > 0,
        instalasiCount,
        aktifCount,
      },
      workOrders: { done: installDoneCount > 0, installDoneCount },
      active: { done: aktifCount > 0, activeCount: aktifCount },
    };
  }
}
