import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PlansRepository } from '../plans/plans.repository';
import {
  type CustomerListFilter,
  type CustomerRow,
  CustomersRepository,
} from './customers.repository';
import type { CreateCustomerInput } from './dto/create-customer.dto';
import type { CustomerResponse } from './dto/customer-response.dto';
import type { UpdateCustomerInput } from './dto/update-customer.dto';
import type { UpdateKycInput } from './dto/update-kyc.dto';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly repo: CustomersRepository,
    // Plans is the source of truth for a customer's plan. We only read it
    // (validate the FK before insert), so depend on the repository.
    private readonly plans: PlansRepository,
  ) {}

  async list(filter: CustomerListFilter): Promise<{ items: CustomerResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toCustomerResponse), total };
  }

  async findById(id: string): Promise<CustomerResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('customer not found');
    return toCustomerResponse(row);
  }

  async create(input: CreateCustomerInput): Promise<CustomerResponse> {
    await this.requirePlan(input.planId);
    const row = await this.repo.create({
      fullName: input.fullName,
      phone: input.phone,
      email: normalizeEmail(input.email),
      address: input.address,
      planId: input.planId,
      // status defaults to 'prospek'; balance/area/provisioning come later.
    });
    this.logger.log({ customerId: row.id }, 'customer created');
    return toCustomerResponse(row);
  }

  async update(id: string, input: UpdateCustomerInput): Promise<CustomerResponse> {
    if (input.planId) await this.requirePlan(input.planId);
    const row = await this.repo.updateProfile(id, {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: normalizeEmail(input.email) } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
    });
    this.logger.log({ customerId: row.id }, 'customer updated');
    return toCustomerResponse(row);
  }

  // --- Lifecycle transitions ------------------------------------------
  // suspend (voluntary) and isolate (non-payment) both land on `isolir`;
  // they differ only in intent + audit action. activate clears the
  // balance (payment received); resume keeps it.

  async suspend(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'isolir', {}, 'suspended');
  }

  async resume(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'aktif', {}, 'resumed');
  }

  async isolate(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'isolir', {}, 'isolated');
  }

  async activate(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'aktif', { clearOutstanding: true }, 'activated');
  }

  async stop(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'berhenti', {}, 'stopped');
  }

  // --- Compliance ------------------------------------------------------

  async recordConsent(id: string): Promise<CustomerResponse> {
    const row = await this.repo.recordConsent(id);
    this.logger.log({ customerId: row.id }, 'consent recorded');
    return toCustomerResponse(row);
  }

  async updateKyc(id: string, input: UpdateKycInput): Promise<CustomerResponse> {
    const row = await this.repo.updateKyc(id, {
      ktp: input.ktp,
      npwp: input.npwp ? input.npwp : null,
    });
    this.logger.log({ customerId: row.id }, 'kyc updated');
    return toCustomerResponse(row);
  }

  async requestDataDeletion(id: string): Promise<void> {
    await this.repo.requestDataDeletion(id);
    this.logger.log({ customerId: id }, 'data deletion requested');
  }

  private async transition(
    id: string,
    status: CustomerRow['status'],
    opts: { clearOutstanding?: boolean },
    verb: string,
  ): Promise<CustomerResponse> {
    const row = await this.repo.setStatus(id, status, opts);
    this.logger.log({ customerId: row.id, status }, `customer ${verb}`);
    return toCustomerResponse(row);
  }

  private async requirePlan(planId: string): Promise<void> {
    const plan = await this.plans.findById(planId);
    if (!plan) {
      // The referenced plan does not exist — a bad reference in the
      // request body, not a missing customer. 400, not 404.
      throw new BadRequestException('plan not found');
    }
  }
}

// '' means "no email" in the UI; store null.
function normalizeEmail(email: string): string | null {
  return email === '' ? null : email;
}

/**
 * Project a stored row onto the public customer shape: join-derived
 * planName, ISO date strings, and the provisioning snapshot. Internal
 * columns (updatedAt, dataDeletionRequestedAt) are dropped.
 */
function toCustomerResponse(row: CustomerRow): CustomerResponse {
  return {
    id: row.id,
    customerNo: row.customerNo,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    areaId: row.areaId,
    areaName: row.areaName,
    planId: row.planId,
    planName: row.planName,
    status: row.status,
    outstanding: row.outstanding,
    npwp: row.npwp,
    ktp: row.ktp,
    consentAt: row.consentAt ? row.consentAt.toISOString() : null,
    resellerName: row.resellerName,
    connection: row.connection ?? null,
    joinedAt: row.createdAt.toISOString(),
  };
}
