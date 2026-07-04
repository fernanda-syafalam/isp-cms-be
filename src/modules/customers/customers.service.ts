import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansRepository } from '../plans/plans.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import {
  type CustomerListFilter,
  type CustomerRow,
  CustomersRepository,
} from './customers.repository';
import type { CreateCustomerInput } from './dto/create-customer.dto';
import type { ChangePlanInput, RelocateInput, SetOnuWifiInput } from './dto/customer-actions.dto';
import type { CustomerResponse } from './dto/customer-response.dto';
import type { UpdateCustomerInput } from './dto/update-customer.dto';
import type { UpdateKycInput } from './dto/update-kyc.dto';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly repo: CustomersRepository,
    // Plans is the source of truth for a customer's plan. We only read it
    // (validate the FK + read price for proration), so depend on the repo.
    private readonly plans: PlansRepository,
    // WhatsApp dunning reminders go through the notifications module.
    private readonly notifications: NotificationsService,
    // Network enforcement: lifecycle transitions toggle the customer's PPPoE
    // secret (ADR-0008). RouterResourcesModule <-> CustomersModule is wired
    // with forwardRef to break the module-import cycle.
    private readonly secrets: SecretsRepository,
  ) {}

  async list(
    filter: CustomerListFilter,
    user?: AuthUser,
  ): Promise<{ items: CustomerResponse[]; total: number }> {
    const scoped = scopeForUser(filter, user);
    // A mitra with no reseller linked sees nothing rather than everything.
    if (!scoped) return { items: [], total: 0 };
    const { items, total } = await this.repo.list(scoped);
    return { items: items.map(toCustomerResponse), total };
  }

  async findById(id: string): Promise<CustomerResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('customer not found');
    return toCustomerResponse(row);
  }

  /**
   * Resolve the subscriber behind a portal session. Authoritative mapping
   * is the customers.user_id FK (P1.3); email is the transition fallback
   * for subscribers created before the linkage existed. Fails closed: no
   * match on either → 404 — never someone else's account (P0.3).
   */
  async resolveForPortal(session: { id: string; email: string | null }): Promise<CustomerResponse> {
    const row =
      (await this.repo.findByUserId(session.id)) ??
      (session.email ? await this.repo.findByEmail(session.email) : null);
    if (!row) throw new NotFoundException('no customer account for this login');
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
      resellerId: input.resellerId ?? null,
      // status defaults to 'prospek'; balance/area/provisioning come later.
    });
    this.logger.log({ customerId: row.id }, 'customer created');
    return toCustomerResponse(row);
  }

  /**
   * Create a subscriber through the onboarding wizard. Unlike create() —
   * which always starts `prospek` — onboarding records the chosen service
   * area and opens the customer in `instalasi` (a linked install work order
   * is scheduled by the onboarding flow).
   */
  async onboard(
    input: CreateCustomerInput & { areaName: string; userId?: string | null },
  ): Promise<CustomerResponse> {
    await this.requirePlan(input.planId);
    const row = await this.repo.create({
      fullName: input.fullName,
      phone: input.phone,
      email: normalizeEmail(input.email),
      address: input.address,
      areaName: input.areaName,
      planId: input.planId,
      status: 'instalasi',
      // Portal login linkage — provisioned by OnboardingService (P1.3),
      // never accepted from the HTTP DTO (no mass-assignment).
      userId: input.userId ?? null,
    });
    this.logger.log({ customerId: row.id }, 'customer onboarded');
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
      ...(input.resellerId !== undefined ? { resellerId: input.resellerId } : {}),
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

  // --- Subscriber actions ---------------------------------------------

  /** Move the customer to a new address + service area. */
  async relocate(id: string, input: RelocateInput): Promise<CustomerResponse> {
    const row = await this.repo.relocate(id, { address: input.address, areaName: input.areaName });
    this.logger.log({ customerId: id }, 'customer relocated');
    return toCustomerResponse(row);
  }

  /** Reboot the customer's ONU — acknowledgment only (GenieACS owns the device). */
  async rebootOnu(id: string, user?: AuthUser): Promise<CustomerResponse> {
    const row = await this.requireById(id);
    this.logger.log({ customerId: id }, 'onu reboot requested');
    return toActionResponse(row, user);
  }

  /** Set the ONU WiFi — acknowledgment only (credentials not persisted here). */
  async setOnuWifi(
    id: string,
    _input: SetOnuWifiInput,
    user?: AuthUser,
  ): Promise<CustomerResponse> {
    const row = await this.requireById(id);
    this.logger.log({ customerId: id }, 'onu wifi set');
    return toActionResponse(row, user);
  }

  /** Fire a WhatsApp billing reminder to the customer. */
  async notifyWhatsapp(id: string): Promise<CustomerResponse> {
    const row = await this.requireById(id);
    await this.notifications.send({ event: 'due_soon', to: row.phone });
    this.logger.log({ customerId: id }, 'whatsapp reminder sent');
    return toCustomerResponse(row);
  }

  /**
   * Change the plan. planName re-derives from the join; an upgrade adds the
   * monthly price delta to the outstanding balance (proration). A formal
   * proration invoice line is a follow-up.
   */
  async changePlan(id: string, input: ChangePlanInput): Promise<CustomerResponse> {
    const customer = await this.requireById(id);
    const newPlan = await this.plans.findById(input.planId);
    if (!newPlan) throw new BadRequestException('plan not found');

    const oldPlan = await this.plans.findById(customer.planId);
    const delta = oldPlan ? Math.max(0, newPlan.priceMonthly - oldPlan.priceMonthly) : 0;

    await this.repo.updateProfile(id, { planId: input.planId });
    if (delta > 0) {
      await this.repo.setBilling(id, { outstanding: customer.outstanding + delta });
    }
    this.logger.log({ customerId: id, planId: input.planId, delta }, 'customer plan changed');
    return this.findById(id);
  }

  private async requireById(id: string): Promise<CustomerRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('customer not found');
    return row;
  }

  private async transition(
    id: string,
    status: CustomerRow['status'],
    opts: { clearOutstanding?: boolean },
    verb: string,
  ): Promise<CustomerResponse> {
    const row = await this.repo.setStatus(id, status, opts);
    // Network enforcement (ADR-0008): the PPPoE secret follows the lifecycle —
    // any non-active state cuts the session, `aktif` restores it. No-op while
    // the customer has no secret yet (prospek/instalasi).
    await this.secrets.setDisabledByCustomerId(id, status !== 'aktif');
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
/**
 * Server-side read scoping (P1.5, ADR-0010): a mitra principal only ever
 * sees their own reseller's acquisitions. The client-supplied filter can
 * never widen this — the reseller constraint is overwritten, and a mitra
 * with no linked reseller gets null (callers return an empty result).
 * Staff/admin (and absent user, e.g. internal calls) pass through.
 */
function scopeForUser(filter: CustomerListFilter, user?: AuthUser): CustomerListFilter | null {
  if (!user || user.role !== 'mitra') return filter;
  if (!user.resellerId) return null;
  return { ...filter, resellerId: user.resellerId };
}

/**
 * Action acknowledgment shape for field (teknisi) callers: same contract
 * as CustomerResponse, but the identity/billing fields a field tech has
 * no business reading (KTP/NPWP/outstanding) are nulled — otherwise the
 * ONU endpoints double as a bulk PII harvest by id iteration (P1 security
 * review M1). Staff/admin get the full row.
 */
function toActionResponse(row: CustomerRow, user?: AuthUser): CustomerResponse {
  const full = toCustomerResponse(row);
  if (!user || user.role !== 'teknisi') return full;
  return { ...full, ktp: null, npwp: null, outstanding: 0 };
}

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
