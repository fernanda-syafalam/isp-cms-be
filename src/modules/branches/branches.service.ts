import { Injectable, Logger } from '@nestjs/common';
import type { Branch } from '../../infrastructure/database/schema/branches.schema';
import {
  type BranchListFilter,
  type BranchSummary,
  BranchesRepository,
} from './branches.repository';
import type { BranchResponse, CreateBranchInput, UpdateBranchInput } from './dto/branch.dto';

@Injectable()
export class BranchesService {
  private readonly logger = new Logger(BranchesService.name);

  constructor(private readonly repo: BranchesRepository) {}

  async list(
    filter: BranchListFilter,
  ): Promise<{ items: BranchResponse[]; total: number; summary: BranchSummary }> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toBranchResponse), total, summary };
  }

  async create(input: CreateBranchInput): Promise<BranchResponse> {
    const branch = await this.repo.create(input);
    this.logger.log({ branchId: branch.id }, 'branch created');
    return toBranchResponse(branch);
  }

  async update(id: string, input: UpdateBranchInput): Promise<BranchResponse> {
    const branch = await this.repo.update(id, input);
    this.logger.log({ branchId: id }, 'branch updated');
    return toBranchResponse(branch);
  }
}

function toBranchResponse(row: Branch): BranchResponse {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    manager: row.manager,
    phone: row.phone,
    status: row.status,
    isHeadOffice: row.isHeadOffice,
    customerCount: row.customerCount,
    mrr: row.mrr,
    deviceCount: row.deviceCount,
  };
}
