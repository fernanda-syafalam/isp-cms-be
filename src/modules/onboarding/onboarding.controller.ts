import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CustomerResponseDto } from '../customers/dto/customer-response.dto';
import { OnboardCustomerDto } from './dto/onboard-customer.dto';
import { OnboardingService } from './onboarding.service';

/**
 * Subscriber onboarding wizard endpoint. Creates the customer + install work
 * order in a single call and returns the new customer.
 */
@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  // Operations + billing staff onboard subscribers, not just admin.
  @Roles('admin', 'staff')
  @Audit('customer.onboard')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(CustomerResponseDto)
  onboard(@Body() body: OnboardCustomerDto) {
    return this.onboarding.onboard(body);
  }
}
