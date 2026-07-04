import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OnboardCustomerDto } from './dto/onboard-customer.dto';
import { OnboardResponseDto } from './dto/onboard-response.dto';
import { OnboardingService } from './onboarding.service';

/**
 * Subscriber onboarding wizard endpoint. Creates the customer + install work
 * order in a single call and returns the new customer.
 */
@Roles('admin', 'staff')
@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  // Operations + billing staff onboard subscribers, not just admin.
  @Roles('admin', 'staff')
  @Audit('customer.onboard')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(OnboardResponseDto)
  onboard(@Body() body: OnboardCustomerDto) {
    return this.onboarding.onboard(body);
  }
}
