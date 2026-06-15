import { Injectable, Logger } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { OnboardCustomerInput } from './dto/onboard-customer.dto';

/**
 * End-to-end subscriber onboarding. A thin aggregator: it creates the
 * customer (status `instalasi`) and a linked install work order in one call,
 * each through its owning module's service. The portal/dashboard read the
 * work order from the work-orders list, so onboarding returns the customer.
 *
 * `note`/`lat`/`lng` from the wizard are FE-side concerns (install hint +
 * topology placement) with no column yet, so they are not persisted here.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly customers: CustomersService,
    private readonly workOrders: WorkOrdersService,
  ) {}

  async onboard(input: OnboardCustomerInput): Promise<CustomerResponse> {
    const customer = await this.customers.onboard({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
      areaName: input.areaName,
      planId: input.planId,
    });
    await this.workOrders.scheduleInstallForCustomer({
      customerId: customer.id,
      customerName: customer.fullName,
      technician: input.technician,
      scheduledAt: new Date(input.scheduledAt),
    });
    this.logger.log({ customerId: customer.id }, 'customer onboarded with install work order');
    return customer;
  }
}
