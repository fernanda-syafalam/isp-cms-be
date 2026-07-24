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
    // Plans is the source of truth for a customer's plan. We only read it
    // to validate the FK (400 on a bad id) before handing off to the
    // repository's atomic changePlan — the repo does the actual price
    // lookups + delta math itself, under its own lock (MUST-FIX #1/#5,
    // PR #121 review).
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
  //
  // Every verb below funnels through `transition()`, the single seam
  // ADR-0004 (Locked rule 3) names as the manual-write gate. `transition()`
  // enforces `CUSTOMER_LEGAL_TRANSITIONS` (D6/NL-2) — see that table for the
  // full from -> to graph and the same-state policy.
  //
  // System-driven (automated) status writes do NOT go through `transition()`
  // and are therefore NOT covered by this table guard — by design. There are
  // two such seams (ADR-0004 rule 3 predates them describing a single
  // `setBilling` seam; the reactivation path has since moved — reconcile in a
  // follow-up so the ADR is not stale):
  //   1. Auto overdue -> isolir: `BillingAutomationService.isolateActiveDebtors()`
  //      via `CustomersRepository.setBilling(...)`.
  //   2. Post-payment reactivation isolir -> aktif: a guarded write to
  //      `customers.status` INSIDE `InvoicesRepository.recordPayment`'s
  //      transaction (`refreshOutstandingTx`, reactivate when
  //      `status === 'isolir' && outstanding === 0`) — NOT `setBilling`. It
  //      lives in the payment transaction on purpose (the status flip is
  //      atomic with the settle); do not re-route it just to unify the seam.
  // Both automated seams gate on the customer's current status inline before
  // writing, so they only ever emit the two ADR-legal auto edges
  // (`aktif->isolir`, `isolir->aktif`) — but that correctness lives in those
  // call sites, not in this table.
  // Follow-up (not covered here): `WorkOrdersService.complete() ->
  // customers.markInstalled()` flips a customer to `aktif` + provisions a
  // secret with no current-status check (guarded only by WO idempotency) —
  // the same status-flip+provision class as D6, reached via WO completion.

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

  /**
   * Fire a manual WhatsApp billing reminder to the customer, through the
   * SAME retried delivery queue as automated dunning (ADR-0012/ADR-0017) —
   * previously this bypassed the queue and called send() directly with no
   * vars, so the template rendered literal `{nama}`/`{jumlah}` and a
   * transient failure had no retry. Best-effort (notifyBestEffort): a
   * queue outage must never fail this admin action.
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
          // Unique per click (not per-cycle like the automated dunning
          // jobId), so an admin re-sending the same reminder is never
          // deduped by BullMQ's idempotent jobId.
          `manual-due_soon:${id}:${Date.now()}`,
        ),
      { event: 'due_soon', customerId: id },
    );
    this.logger.log({ customerId: id }, 'whatsapp reminder enqueued');
    return toCustomerResponse(row);
  }

  /**
   * Change the plan. planName re-derives from the join. An upgrade (delta
   * > 0) or downgrade (delta < 0) prorates the monthly price difference —
   * backed by a REAL invoice line, atomically, via
   * `CustomersRepository.changePlan` (MUST-FIX #1/#5, PR #121 review): the
   * plan write, the delta computation, and the charge/credit all happen
   * inside ONE transaction there, under a customer-row lock that also
   * makes two concurrent/retried calls to the SAME target plan idempotent
   * (only the first one actually applies a delta — see that method's doc).
   * This service method does no money math itself: it only validates the
   * target plan exists (400 on a bad id) and reads the billing policy's
   * `dueDays` for the adjustment invoice's grace period (MED #4).
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
    // D6/NL-2: read the current status and validate BEFORE any write — the
    // DB update (repo.setStatus) and the network enforcement side effect
    // (secrets.applyDisabledForCustomer) must never fire for an illegal
    // pair. requireById() also gives the existing 404-on-missing-customer
    // behaviour for free.
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
 * D6/NL-2 (go-live defect): the canonical lifecycle graph locked in
 * ADR-0004's "Transition table (locked)" — every edge below cites the ADR
 * row that authorizes it. This is the from -> to allow-list `transition()`
 * enforces; anything not listed for a given `from` is illegal.
 *
 * - `prospek -> instalasi`: ADR-0004 row "prospek | instalasi | onboard()".
 *   Not reachable through `transition()` today (onboard() writes the status
 *   via repo.create(), a separate entry point per ADR-0004's "Entry points"
 *   section) — listed anyway so the table stays a complete, ADR-faithful
 *   graph for any future caller of `transition()`, and so it is directly
 *   unit-testable.
 * - `instalasi -> aktif`: ADR-0004 row "instalasi | aktif | WO complete() ->
 *   markInstalled". Reached via `CustomersRepository.markInstalled` (work
 *   orders), not `transition()` — same rationale as above.
 * - `aktif -> isolir`: ADR-0004 rows "aktif|isolir|suspend()" and
 *   "aktif|isolir|isolate()" (manual verbs; the third row, auto overdue,
 *   goes through `setBilling`, not this seam — see the class-level note).
 * - `isolir -> aktif`: ADR-0004 rows "isolir|aktif|resume()" and
 *   "isolir|aktif|activate()" (manual verbs; the third row, auto payment
 *   reactivation, also goes through `setBilling`).
 * - `aktif -> berhenti` and `isolir -> berhenti`: ADR-0004 rows
 *   "aktif|berhenti|stop()" and "isolir|berhenti|stop()".
 * - `berhenti`: terminal — ADR-0004's canonical graph ends `berhenti -->
 *   [*]` with no outgoing edge. `berhenti -> aktif` and `berhenti -> isolir`
 *   are therefore illegal by omission (this is the D6 bug: today
 *   `activate()` on a churned customer silently re-enables their PPPoE
 *   secret for free).
 * - `prospek -> aktif`: illegal by omission — ADR-0004 has no such edge; a
 *   prospect must pass through `instalasi` (provisioning) first. This is
 *   the other half of the D6 bug (skipping install/provisioning).
 *
 * Same-state (X -> X) policy: deliberately NOT included for any status.
 * None of ADR-0004's locked edges are self-loops, and in practice a
 * same-state call is a UI double-submit / stale client, not a real intent
 * change — reject it explicitly (400) rather than a silent no-op, so the
 * mistake is visible at the call site instead of looking like it worked.
 * (One legitimate same-state case ADR-0004 does not cover — reclassifying
 * an `isolir` customer's `holdReason`, e.g. overdue -> voluntary, without
 * leaving `isolir` — is out of scope for this guard; flag as a follow-up
 * if that workflow is needed.)
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
 *
 * `unassignedReseller` (#25, ops diagnostic for admin/staff) is force-set
 * to `false` here too: without this, a mitra passing `?unassignedReseller
 * =true` would have `resellerId` overwritten below but the repository's
 * `buildScopeWhere` prefers `unassignedReseller` over `resellerId` — so
 * the override alone would let a mitra see every reseller-less customer
 * (a real scope escape). Clearing the flag closes that gap; only
 * staff/admin (who bypass this function entirely) can use it.
 */
function scopeForUser(filter: CustomerListFilter, user?: AuthUser): CustomerListFilter | null {
  if (!user || user.role !== 'mitra') return filter;
  if (!user.resellerId) return null;
  return { ...filter, resellerId: user.resellerId, unassignedReseller: false, excludeKyc: true };
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
