import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansRepository } from '../plans/plans.repository';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import {
  type CustomerListFilter,
  type CustomerRow,
  CustomersRepository,
} from './customers.repository';
import type { CreateCustomerInput } from './dto/create-customer.dto';
import type { ChangePlanInput, RelocateInput, SetOnuWifiInput } from './dto/customer-actions.dto';
import type { CustomerListResponse, CustomerResponse } from './dto/customer-response.dto';
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
    // secret in the DB and push it to the router (ADR-0008 / P2.5).
    // RouterResourcesModule <-> CustomersModule is wired with forwardRef to
    // break the module-import cycle.
    private readonly secrets: SecretEnforcementService,
    // Validates the resellerId FK on onboard (P3.D.2) — a bad id fails
    // explicit (400) instead of surfacing as a DB-level 500.
    private readonly resellers: ResellersRepository,
  ) {}

  async list(filter: CustomerListFilter, user?: AuthUser): Promise<CustomerListResponse> {
    const scoped = scopeForUser(filter, user);
    // A mitra with no reseller linked sees nothing rather than everything.
    if (!scoped) {
      return {
        items: [],
        total: 0,
        summary: {
          total: 0,
          outstanding: 0,
          byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
        },
      };
    }
    const { items, total, summary } = await this.repo.list(scoped);
    // KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): a mitra
    // never sees npwp/ktp — the repository already never read the real
    // column value (scoped.excludeKyc, set by scopeForUser), and the
    // response mapper below omits the keys entirely (not merely null).
    const includeKyc = user?.role !== 'mitra';
    return { items: items.map((row) => toCustomerResponse(row, { includeKyc })), total, summary };
  }

  /**
   * `user` is optional: the many internal cross-module callers of this
   * method (tickets, work-orders, invoices, contracts, sla-credits,
   * portal, vouchers, onboarding — none of them HTTP-facing on behalf of
   * a mitra) never pass one and always get the full row, exactly as
   * before this change. Only the HTTP `GET /v1/customers/:id` handler
   * passes the caller's `AuthUser`.
   *
   * For a mitra principal (ADR-0010 amendment / ADR-0015, SEC-4):
   * - the reseller-ownership check below is the detail-route counterpart
   *   of the list() scoping (ADR-0010) — a mitra may only read their own
   *   reseller's customers by id too. Fails closed with 404 (not 403) so
   *   another reseller's customer id is not probeable (mirrors
   *   ResellersService.assertResellerAccess).
   * - the KYC fields (npwp/ktp) are excluded at the query layer and
   *   omitted from the response entirely.
   */
  async findById(id: string, user?: AuthUser): Promise<CustomerResponse> {
    const isMitra = user?.role === 'mitra';
    const row = await this.repo.findById(id, { excludeKyc: isMitra });
    if (!row) throw new NotFoundException('customer not found');
    if (isMitra && (!user?.resellerId || row.resellerId !== user.resellerId)) {
      throw new NotFoundException('customer not found');
    }
    return toCustomerResponse(row, { includeKyc: !isMitra });
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
    input: CreateCustomerInput & {
      areaName: string;
      userId?: string | null;
      lat?: number | null;
      lng?: number | null;
      odpId?: string | null;
      ktp?: string | null;
      npwp?: string | null;
      consentAt?: Date | null;
      // resellerId is already on CreateCustomerInput (P1.5) — validated by
      // requireResellerIfProvided below (P3.D.2).
    },
  ): Promise<CustomerResponse> {
    await this.requirePlan(input.planId);
    await this.requireResellerIfProvided(input.resellerId);
    const row = await this.repo.create({
      fullName: input.fullName,
      phone: input.phone,
      email: normalizeEmail(input.email),
      address: input.address,
      areaName: input.areaName,
      planId: input.planId,
      status: 'instalasi',
      // Geo pin + ODP assignment + KYC captured at onboarding (P3.A.1). All
      // nullable. The ODP port itself is reserved by the caller (Onboarding
      // Service) BEFORE this runs — this only stamps the FK on the row.
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      odpId: input.odpId ?? null,
      ktp: input.ktp ?? null,
      npwp: input.npwp ?? null,
      consentAt: input.consentAt ?? null,
      resellerId: input.resellerId ?? null,
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
    // Voluntary hold (cuti) — a customer request, not a debt (P3.A.3).
    return this.transition(id, 'isolir', { holdReason: 'voluntary' }, 'suspended');
  }

  async resume(id: string): Promise<CustomerResponse> {
    return this.transition(id, 'aktif', {}, 'resumed');
  }

  async isolate(id: string): Promise<CustomerResponse> {
    // Punitive isolation for non-payment.
    return this.transition(id, 'isolir', { holdReason: 'overdue' }, 'isolated');
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
    opts: { clearOutstanding?: boolean; holdReason?: CustomerRow['holdReason'] },
    verb: string,
  ): Promise<CustomerResponse> {
    const row = await this.repo.setStatus(id, status, opts);
    // Network enforcement (ADR-0008): the PPPoE secret follows the lifecycle —
    // any non-active state cuts the session, `aktif` restores it. No-op while
    // the customer has no secret yet (prospek/instalasi).
    await this.secrets.applyDisabledForCustomer(id, status !== 'aktif');
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

  /**
   * Guard for the optional resellerId FK (P3.D.2): when a caller supplies
   * one (direct onboarding or a converted lead), it must reference a real
   * reseller — otherwise this fails explicit (400) here instead of at the
   * DB as an FK-violation 500.
   */
  private async requireResellerIfProvided(resellerId?: string | null): Promise<void> {
    if (!resellerId) return;
    const reseller = await this.resellers.findById(resellerId);
    if (!reseller) {
      throw new BadRequestException('reseller not found');
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
 *
 * `excludeKyc: true` (ADR-0010 amendment / ADR-0015, SEC-4) rides along
 * with the same mitra branch: a mitra is both scoped to their own
 * reseller AND denied the KYC columns at the query layer — the two are
 * separate concerns (authorization boundary vs. data minimization) but
 * both are set here, in the one place a mitra filter is built, so a
 * future caller cannot apply one without the other.
 */
function scopeForUser(filter: CustomerListFilter, user?: AuthUser): CustomerListFilter | null {
  if (!user || user.role !== 'mitra') return filter;
  if (!user.resellerId) return null;
  return { ...filter, resellerId: user.resellerId, excludeKyc: true };
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

/**
 * KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): when
 * `includeKyc` is false (a mitra caller), `npwp`/`ktp` are omitted from
 * the returned object entirely — not merely set to null — so the
 * serialized JSON never carries those keys. Defaults to `true`: every
 * other caller (admin/staff endpoints, and every internal cross-module
 * call to `CustomersService.findById()` that never passes a user) is
 * unaffected. The repository has already replaced the real column value
 * with a SQL NULL for the mitra case (`CustomersRepository.
 * baseSelectKycSafe`), so this is defense in depth, not the only guard.
 */
function toCustomerResponse(
  row: CustomerRow,
  opts: { includeKyc?: boolean } = {},
): CustomerResponse {
  const base = {
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
    holdReason: row.holdReason,
    outstanding: row.outstanding,
    // Billing config, not KYC (ADR-0011 parity) — included for every role,
    // unlike npwp/ktp below which are gated by opts.includeKyc.
    billingAnchorDay: row.billingAnchorDay,
    consentAt: row.consentAt ? row.consentAt.toISOString() : null,
    resellerName: row.resellerName,
    connection: row.connection ?? null,
    joinedAt: row.createdAt.toISOString(),
  };
  if (opts.includeKyc === false) return base;
  return { ...base, npwp: row.npwp, ktp: row.ktp };
}
