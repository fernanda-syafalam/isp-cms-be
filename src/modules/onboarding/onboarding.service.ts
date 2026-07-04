import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { UsersService } from '../users/users.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { OnboardCustomerInput } from './dto/onboard-customer.dto';

/**
 * End-to-end subscriber onboarding. A thin aggregator: it provisions the
 * portal login (customer-role user, P1.3), creates the customer (status
 * `instalasi`, linked to that login), and schedules a linked install work
 * order — each through its owning module's service.
 *
 * Customer accounts are onboarding-only (owner decision, plan §0.1): there
 * is no public self-signup, so this is the single place a customer login
 * is born. Until P2 notifications can deliver a set-password link, the
 * generated initial password is returned once in the response for staff
 * to communicate to the subscriber.
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
    private readonly users: UsersService,
  ) {}

  async onboard(input: OnboardCustomerInput): Promise<OnboardResult> {
    const login = await this.provisionLogin(input);

    const customer = await this.customers.onboard({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
      areaName: input.areaName,
      planId: input.planId,
      userId: login?.userId ?? null,
    });
    await this.workOrders.scheduleInstallForCustomer({
      customerId: customer.id,
      customerName: customer.fullName,
      technician: input.technician,
      scheduledAt: new Date(input.scheduledAt),
    });
    this.logger.log({ customerId: customer.id }, 'customer onboarded with install work order');
    return {
      ...customer,
      portalLogin: login ? { email: login.email, initialPassword: login.initialPassword } : null,
    };
  }

  /**
   * Create the customer-role portal login for the new subscriber. Skipped
   * (with a warning) when the wizard has no email or the email already
   * belongs to a user — linking an existing principal to a new subscriber
   * is a manual staff decision, never an automatic side effect.
   */
  private async provisionLogin(
    input: OnboardCustomerInput,
  ): Promise<{ userId: string; email: string; initialPassword: string } | null> {
    if (!input.email) return null;

    const initialPassword = generateInitialPassword();
    try {
      const user = await this.users.create({
        email: input.email,
        fullName: input.fullName,
        password: initialPassword,
        role: 'customer',
      });
      return { userId: user.id, email: user.email, initialPassword };
    } catch (err) {
      if (err instanceof ConflictException) {
        this.logger.warn(
          { email: input.email },
          'onboarding: email already has a login — customer created unlinked',
        );
        return null;
      }
      throw err;
    }
  }
}

export type OnboardResult = CustomerResponse & {
  portalLogin: { email: string; initialPassword: string } | null;
};

// 18 base64url chars (~108 bits) — comfortably over the 12-char minimum in
// CreateUserSchema and communicated once by staff; the subscriber rotates
// it via the password lifecycle (P1.4).
function generateInitialPassword(): string {
  return randomBytes(13).toString('base64url').slice(0, 18);
}
