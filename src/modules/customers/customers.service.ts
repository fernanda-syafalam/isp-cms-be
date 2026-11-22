import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import { formatIdr } from '../../common/utils/format-idr';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansRepository } from '../plans/plans.repository';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
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
    // Read-only: validates the plan FK (400); repo.changePlan does price lookups + delta math
    // under its own lock (MUST-FIX #1/#5, PR #121).
    private readonly plans: PlansRepository,
    // WhatsApp dunning reminders go through the notifications module.
    private readonly notifications: NotificationsService,
    // Toggles the customer's PPPoE secret in DB and router (ADR-0008 / P2.5). forwardRef with
    // RouterResourcesModule breaks the import cycle.
    private readonly secrets: SecretEnforcementService,
    // Validates the resellerId FK on onboard (P3.D.2): 400 instead of a DB-level 500.
    private readonly resellers: ResellersRepository,
    // Billing policy (dueDays) for a proration adjustment invoice's grace
    // period — same grace a regular invoice gets (MED #4, PR #121 review).
    private readonly settings: SettingsService,
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
    // KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): a mitra never sees npwp/ktp;
    // see toCustomerResponse.
    const includeKyc = user?.role !== 'mitra';
    return { items: items.map((row) => toCustomerResponse(row, { includeKyc })), total, summary };
  }

  /**
   * `user` is optional: internal cross-module callers never pass one and get the full row; only
   * the HTTP `GET /v1/customers/:id` handler passes the caller.
   * For a mitra (ADR-0010 amendment / ADR-0015, SEC-4): reseller ownership is checked as the
   * detail-route counterpart of list() scoping, failing 404 (not 403) so ids are not probeable
   * (as ResellersService.assertResellerAccess); KYC fields are excluded at the query layer and
   * omitted from the response.
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
   * Portal session -> subscriber: `customers.user_id` FK (P1.3) first, email fallback for
   * subscribers created before the linkage. Fails closed (404), never someone else's account (P0.3).
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
   * Onboarding-wizard create: unlike create() (`prospek`), records the service area and opens
   * in `instalasi`.
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
      // Geo pin, ODP and KYC captured at onboarding (P3.A.1). The ODP port is reserved by
      // OnboardingService BEFORE this runs; this only stamps the FK.
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
    const row = await this.repo.updateProfile(id, {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: normalizeEmail(input.email) } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.resellerId !== undefined ? { resellerId: input.resellerId } : {}),
    });
    this.logger.log({ customerId: row.id }, 'customer updated');
    return toCustomerResponse(row);
  }

  // --- Lifecycle transitions ------------------------------------------
  // suspend (voluntary) and isolate (non-payment) both land on `isolir`; they differ only in
  // intent + audit action. activate clears the balance (payment received); resume keeps it.
  //
  // Every verb funnels through `transition()`, the manual-write gate (ADR-0004 rule 3), which
  // enforces `CUSTOMER_LEGAL_TRANSITIONS` (D6/NL-2).
  //
  // System-driven writes bypass `transition()` by design and gate on current status inline,
  // so they only emit the two auto edges:
  //   1. overdue aktif -> isolir: `BillingAutomationService.isolateActiveDebtors()` via setBilling.
  //   2. payment isolir -> aktif: guarded write inside `InvoicesRepository.recordPayment`'s
  //      transaction (`refreshOutstandingTx`), atomic with the settle; do not re-route it via
  //      `setBilling`.
  // WO completion (instalasi -> aktif) is guarded by `assertCustomerReadyForInstallActivation`.

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

  /**
   * Reclassify why an `isolir` customer is held (overdue <-> voluntary, P3.A.3). Bypasses
   * `transition()` on purpose: status never changes and its same-state guard would reject
   * isolir -> isolir. Plain field write gated by `assertCustomerIsHeld`.
   * Safe as a naive swap: the auto-isolir sweep, payment reactivation and
   * `applyDisabledForCustomer` all key off `status`, not `holdReason`, so network enforcement
   * is untouched.
   */
  async reclassifyHold(
    id: string,
    holdReason: NonNullable<CustomerRow['holdReason']>,
  ): Promise<CustomerResponse> {
    const current = await this.requireById(id);
    assertCustomerIsHeld(current.status);
    const row = await this.repo.reclassifyHold(id, holdReason);
    this.logger.log({ customerId: row.id, holdReason }, 'customer hold reclassified');
    return toCustomerResponse(row);
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

  /**
   * Manual WhatsApp billing reminder through the same retried queue as automated dunning
   * (ADR-0012/ADR-0017). Best-effort: a queue outage must not fail this admin action.
   */
  async notifyWhatsapp(id: string): Promise<CustomerResponse> {
    const row = await this.requireById(id);
    await notifyBestEffort(
      this.logger,
      () =>
        this.notifications.enqueue(
          {
            event: 'due_soon',
            to: row.phone,
            vars: { nama: row.fullName, jumlah: formatIdr(row.outstanding) },
          },
          // Unique per click so BullMQ's idempotent jobId never dedupes an admin re-send.
          `manual-due_soon:${id}:${Date.now()}`,
        ),
      { event: 'due_soon', customerId: id },
    );
    this.logger.log({ customerId: id }, 'whatsapp reminder enqueued');
    return toCustomerResponse(row);
  }

  /**
   * Change the plan, prorating the monthly price delta as a real invoice line. Plan write, delta
   * and charge/credit run in ONE transaction under a customer-row lock in
   * `CustomersRepository.changePlan`, which also makes concurrent/retried calls to the same
   * target idempotent (MUST-FIX #1/#5, PR #121). No money math here: this validates the plan
   * (400) and reads billing `dueDays` for the adjustment invoice's grace (MED #4).
   */
  async changePlan(id: string, input: ChangePlanInput): Promise<CustomerResponse> {
    await this.requireById(id); // 404 first — the atomic repo call re-validates for real under its own lock.
    const newPlan = await this.plans.findById(input.planId);
    if (!newPlan) throw new BadRequestException('plan not found');

    const { dueDays } = await this.settings.getBillingPolicy();
    const result = await this.repo.changePlan(id, { targetPlanId: input.planId, dueDays });

    this.logger.log(
      { customerId: id, planId: input.planId, applied: result.applied, delta: result.delta },
      'customer plan changed',
    );
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
    // D6/NL-2: validate BEFORE any write so neither repo.setStatus nor the network side effect
    // fires for an illegal pair. requireById() also gives 404 on a missing customer.
    const current = await this.requireById(id);
    assertLegalCustomerTransition(current.status, status);
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
      // Bad reference in the request body, not a missing customer: 400, not 404.
      throw new BadRequestException('plan not found');
    }
  }

  /** Optional resellerId FK (P3.D.2): 400 here instead of a DB FK-violation 500. */
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
 * Allow-list from ADR-0004 "Transition table (locked)" (D6/NL-2); `transition()` rejects any
 * edge not listed for the `from` status.
 *
 * - `prospek -> instalasi` (onboard() via repo.create), `instalasi -> aktif` (WO complete() ->
 *   markInstalled) and the auto edges (setBilling isolir/aktif) are reached outside
 *   `transition()`; the first two are listed for graph completeness and unit-testability.
 * - `berhenti` is terminal: `berhenti -> aktif/isolir` are illegal by omission (guards D6:
 *   activating a churned customer would re-enable their PPPoE secret for free).
 * - `prospek -> aktif` is illegal: a prospect must pass through `instalasi` (provisioning).
 * - Same-state (X -> X) is deliberately absent: it is a UI double-submit / stale client, so it
 *   is rejected with 400 to stay visible rather than a silent no-op.
 * - Changing `holdReason` while staying `isolir` goes through `reclassifyHold`, not here.
 */
export const CUSTOMER_LEGAL_TRANSITIONS: Readonly<
  Record<CustomerRow['status'], readonly CustomerRow['status'][]>
> = {
  prospek: ['instalasi'],
  instalasi: ['aktif'],
  aktif: ['isolir', 'berhenti'],
  isolir: ['aktif', 'berhenti'],
  berhenti: [],
};

/** Throws `BadRequestException` when `from -> to` is not in the ADR-0004 graph. */
export function assertLegalCustomerTransition(
  from: CustomerRow['status'],
  to: CustomerRow['status'],
): void {
  const allowed = CUSTOMER_LEGAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new BadRequestException(`cannot transition from ${from} to ${to}`);
  }
}

/**
 * Guard for the non-`transition()` seam to `instalasi -> aktif`
 * (`WorkOrdersService.complete()` -> `markInstalled`).
 * Narrower than `assertLegalCustomerTransition(status, 'aktif')`, which also allows
 * `isolir -> aktif`: an install WO completing for an `isolir` customer must be rejected, not
 * treated as a resume.
 */
export function assertCustomerReadyForInstallActivation(status: CustomerRow['status']): void {
  const from: CustomerRow['status'] = 'instalasi';
  if (status !== from) {
    throw new BadRequestException(
      `cannot complete install work order: customer is ${status}, expected ${from}`,
    );
  }
}

/** Guard for `reclassifyHold`: holdReason is only meaningful while `isolir`; otherwise 400. */
export function assertCustomerIsHeld(status: CustomerRow['status']): void {
  if (status !== 'isolir') {
    throw new BadRequestException(
      `cannot reclassify hold reason: customer is ${status}, expected isolir`,
    );
  }
}

/**
 * Read scoping (P1.5, ADR-0010): a mitra only sees their own reseller's customers; the client
 * filter can never widen it, and a mitra with no linked reseller gets null (callers return empty).
 * `excludeKyc` (SEC-4) is set in the same branch so the KYC denial cannot be forgotten.
 * `unassignedReseller` is forced false: the repository's `buildScopeWhere` prefers it over
 * `resellerId`, so `?unassignedReseller=true` would otherwise expose every reseller-less
 * customer (scope escape).
 */
function scopeForUser(filter: CustomerListFilter, user?: AuthUser): CustomerListFilter | null {
  if (!user || user.role !== 'mitra') return filter;
  if (!user.resellerId) return null;
  return { ...filter, resellerId: user.resellerId, unassignedReseller: false, excludeKyc: true };
}

/**
 * Action ack for field (teknisi) callers: KTP/NPWP/outstanding are nulled so the ONU endpoints
 * cannot double as a bulk PII harvest by id iteration (P1 security review M1).
 */
function toActionResponse(row: CustomerRow, user?: AuthUser): CustomerResponse {
  const full = toCustomerResponse(row);
  if (!user || user.role !== 'teknisi') return full;
  return { ...full, ktp: null, npwp: null, outstanding: 0 };
}

/**
 * Project a stored row onto the public customer shape (join-derived planName, ISO dates,
 * provisioning snapshot; internal columns dropped).
 *
 * KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): with `includeKyc` false (mitra)
 * `npwp`/`ktp` are omitted entirely, not nulled, so the JSON never carries the keys. Defaults to
 * true. The repository already NULLs the column for mitra (`baseSelectKycSafe`); this is defense
 * in depth.
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
