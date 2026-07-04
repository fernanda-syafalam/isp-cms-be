import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ContractsService } from './contracts.service';
import { ContractResponseDto } from './dto/contract-response.dto';

// Nested under the subscriber — a contract (PKS) belongs to one customer.
@Roles('admin', 'staff')
@Controller({ path: 'customers/:customerId/contract', version: '1' })
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  // Returns { contract: Contract | null } — null (not 404) when none exists.
  @Get()
  get(@Param('customerId') customerId: string) {
    return this.contracts.getForCustomer(customerId);
  }

  @Roles('admin', 'staff')
  @Audit('contract.create')
  @Post()
  @ZodSerializerDto(ContractResponseDto)
  create(@Param('customerId') customerId: string) {
    return this.contracts.create(customerId);
  }

  @Roles('admin', 'staff')
  @Audit('contract.send')
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(ContractResponseDto)
  send(@Param('customerId') customerId: string) {
    return this.contracts.send(customerId);
  }

  // Sign + apply e-Meterai.
  @Roles('admin', 'staff')
  @Audit('contract.sign')
  @Post('sign')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(ContractResponseDto)
  sign(@Param('customerId') customerId: string) {
    return this.contracts.sign(customerId);
  }
}
