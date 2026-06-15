import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Contract } from '../../infrastructure/database/schema/contracts.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { ContractsRepository } from './contracts.repository';
import type { ContractResponse } from './dto/contract-response.dto';

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly repo: ContractsRepository,
    // Reads the customer to snapshot name + plan onto a new contract.
    private readonly customers: CustomersRepository,
  ) {}

  /** GET wrapper — { contract: null } when none exists yet (not a 404). */
  async getForCustomer(customerId: string): Promise<{ contract: ContractResponse | null }> {
    const contract = await this.repo.findByCustomerId(customerId);
    return { contract: contract ? toContractResponse(contract) : null };
  }

  /** Create a draft PKS. Idempotent: returns the existing one if present. */
  async create(customerId: string): Promise<ContractResponse> {
    const existing = await this.repo.findByCustomerId(customerId);
    if (existing) return toContractResponse(existing);

    const customer = await this.customers.findById(customerId);
    if (!customer) throw new NotFoundException('customer not found');

    const contract = await this.repo.create({
      customerId,
      customerName: customer.fullName,
      planName: customer.planName,
    });
    this.logger.log({ contractId: contract.id }, 'contract created');
    return toContractResponse(contract);
  }

  /** Send for signature (draft|sent -> sent). A signed PKS cannot be re-sent. */
  async send(customerId: string): Promise<ContractResponse> {
    const contract = await this.requireByCustomer(customerId);
    if (contract.status === 'signed') {
      throw new BadRequestException('contract already signed');
    }
    const sent = await this.repo.markSent(customerId);
    return toContractResponse(sent);
  }

  /** Sign + apply e-Meterai. Idempotent for an already-signed PKS. */
  async sign(customerId: string): Promise<ContractResponse> {
    const contract = await this.requireByCustomer(customerId);
    if (contract.status === 'signed') return toContractResponse(contract);
    const signed = await this.repo.markSigned(customerId);
    this.logger.log({ contractId: signed.id }, 'contract signed (e-meterai)');
    return toContractResponse(signed);
  }

  private async requireByCustomer(customerId: string): Promise<Contract> {
    const contract = await this.repo.findByCustomerId(customerId);
    if (!contract) throw new NotFoundException('contract not found');
    return contract;
  }
}

function toContractResponse(row: Contract): ContractResponse {
  return {
    id: row.id,
    number: row.number,
    customerId: row.customerId,
    customerName: row.customerName,
    planName: row.planName,
    status: row.status,
    meterai: row.meterai,
    createdAt: row.createdAt.toISOString(),
    signedAt: row.signedAt ? row.signedAt.toISOString() : null,
  };
}
