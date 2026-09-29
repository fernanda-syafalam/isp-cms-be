import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import type { CustomerConnection } from '../../infrastructure/database/schema/customers.schema';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { type CustomerRow, CustomersRepository } from '../customers/customers.repository';
// Reuses the ADR-0004 legal-transition check rather than duplicating a status check.
import { assertCustomerReadyForInstallActivation } from '../customers/customers.service';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { RoutersRepository } from '../routers/routers.repository';
// Closes the repair loop on complete() (P3.B.4). TicketsModule imports WorkOrdersModule, so both
// sides need forwardRef() — see work-orders.module.ts.
import { TicketsService } from '../tickets/tickets.service';
import type { CompleteWorkOrderInput } from './dto/complete-work-order.dto';
import type { WorkOrderListResponse, WorkOrderResponse } from './dto/work-order-response.dto';
import {
  type WorkOrderCompletion,
  type WorkOrderListFilter,
  WorkOrdersRepository,
} from './work-orders.repository';

// A repair dispatched from a ticket is scheduled for the next day.
const REPAIR_LEAD_MS = 24 * 3_600_000;
// An install scheduled when a lead converts gets a two-day lead time.
const INSTALL_LEAD_MS = 2 * 24 * 3_600_000;

@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly repo: WorkOrdersRepository,
    private readonly customers: CustomersRepository,
    private readonly invoices: InvoicesService,
    private readonly inventory: InventoryService,
    private readonly routers: RoutersRepository,
    private readonly profiles: ProfilesRepository,
    private readonly secrets: SecretsRepository,
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    // Customer-facing wo_scheduled/wo_done notices; best-effort (ADR-0012).
    private readonly notifications: NotificationsService,
  ) {}

  async list(filter: WorkOrderListFilter): Promise<WorkOrderListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toWorkOrderResponse), total, summary };
  }

  /**
   * Complete a work order. For an install with a linked subscriber this runs the activation cascade:
   *   1. consume an ONU from warehouse stock,
   *   2. provision a PPPoE secret on the default router,
   *   3. issue the first invoice,
   *   4. `markInstalled` (activate + attach the GPON connection) — LAST, on purpose; see the call site.
   * Idempotent: a done order returns unchanged. The cascade is not transactional, so a retry
   * re-enters every step; each step guards on existing state and never double-provisions.
   *
   * Activation only fires while the customer is still `instalasi` (see
   * `assertCustomerReadyForInstallActivation`); any other status rejects with a 400 rather than
   * re-activating / re-billing. Because the status flip commits last, a retry after an earlier
   * failure still passes the guard — do not move `markInstalled` earlier without re-checking this.
   *
   * External steps degrade gracefully: no ONU in stock -> synthetic serial; no router/profile ->
   * secret skipped (logged). The customer is always activated and billed.
   *
   * A repair WO linked to a ticket also auto-resolves it (or marks it breached past SLA); the
   * done-order no-op makes that fire exactly once (P3.B.4).
   */
  async complete(
    id: string,
    author: string,
    data?: CompleteWorkOrderInput,
  ): Promise<WorkOrderResponse> {
    const wo = await this.repo.findById(id);
    if (!wo) throw new NotFoundException('work order not found');
    if (wo.status === 'done') {
      return toWorkOrderResponse(wo);
    }

    if (wo.type === 'install') {
      // An install order must carry its subscriber; skipping activation, provisioning and the first
      // invoice silently is the lead-convert break this guards against (ADR-0009).
      if (!wo.customerId) {
        throw new BadRequestException('install work order is not linked to a customer');
      }
      const customer = await this.customers.findById(wo.customerId);
      if (customer) {
        // Read the movement ledger BEFORE the guard: a movement for this WO marks a prior attempt of
        // this cascade, used by the guard bypass below and by `assignOnu` (one read, passed through).
        const alreadyAssignedSerial = await this.inventory.findAssignedSerialForWorkOrder(wo.id);

        // This cascade is the ADR-0004 `instalasi -> aktif` edge but is otherwise reachable in any
        // status; the `done` no-op above doesn't cover a customer who left `instalasi` another way.
        //
        // Bypass: markInstalled is the last mutation, so a retry normally still sees `instalasi`. The
        // one residual window is a failure after markInstalled committed but before repo.markDone,
        // leaving the customer `aktif`. An `assign` movement recorded for THIS wo.id proves this
        // cascade reached assignOnu (always before markInstalled), so that case is allowed; an `aktif`
        // customer with no movement for this WO is still rejected.
        if (customer.status !== 'aktif' || !alreadyAssignedSerial) {
          assertCustomerReadyForInstallActivation(customer.status);
        }

        const onuSerial = await this.assignOnu(
          customer.fullName,
          wo.id,
          data?.onuSerial,
          alreadyAssignedSerial,
        );
        // markInstalled (the `status: 'aktif'` write) runs LAST: provisionSecret and
        // generateFirstInvoice don't need status 'aktif', so a failure at either leaves the customer
        // `instalasi` and a retry passes the guard again, re-running both under their own
        // idempotency. Flipping first made a post-flip failure permanently uncompletable (the guard
        // rejects the retry). markInstalled is an idempotent UPDATE, so re-issuing it is harmless.
        await this.provisionSecret(customer);
        await this.invoices.generateFirstInvoice(wo.customerId);
        await this.customers.markInstalled(
          wo.customerId,
          buildConnection(customer, onuSerial, data?.rxPower),
        );
      }
    }

    const done = await this.repo.markDone(id, buildCompletion(author, data));
    this.logger.log({ workOrderId: id, type: wo.type }, 'work order completed');

    if (wo.type === 'repair' && wo.ticketId) {
      await this.tickets.resolveFromWorkOrder(wo.ticketId, done.code, author);
    }

    await this.notifyWoDone(done);

    return toWorkOrderResponse(done);
  }

  /** Start a scheduled order (→ in_progress). Idempotent if already in progress. */
  async start(id: string): Promise<WorkOrderResponse> {
    const wo = await this.requireOpen(id);
    if (wo.status === 'in_progress') return toWorkOrderResponse(wo);
    if (wo.status !== 'scheduled') {
      throw new BadRequestException(`cannot start a ${wo.status} work order`);
    }
    const started = await this.repo.patch(id, { status: 'in_progress' });
    this.logger.log({ workOrderId: id }, 'work order started');
    return toWorkOrderResponse(started);
  }

  /** Cancel an open order (scheduled/in_progress → cancelled). */
  async cancel(id: string): Promise<WorkOrderResponse> {
    const wo = await this.repo.findById(id);
    if (!wo) throw new NotFoundException('work order not found');
    if (wo.status === 'cancelled') return toWorkOrderResponse(wo);
    if (wo.status === 'done') {
      throw new BadRequestException('cannot cancel a completed work order');
    }
    const cancelled = await this.repo.patch(id, { status: 'cancelled' });
    this.logger.log({ workOrderId: id }, 'work order cancelled');
    return toWorkOrderResponse(cancelled);
  }

  /** (Re)assign the field technician on an open order. */
  async assign(id: string, technician: string): Promise<WorkOrderResponse> {
    const wo = await this.requireOpen(id);
    const assigned = await this.repo.patch(wo.id, { technician });
    this.logger.log({ workOrderId: id, technician }, 'work order assigned');
    return toWorkOrderResponse(assigned);
  }

  /** Reschedule an open order to a new date/time. */
  async reschedule(id: string, scheduledAt: Date): Promise<WorkOrderResponse> {
    const wo = await this.requireOpen(id);
    const rescheduled = await this.repo.patch(wo.id, { scheduledAt });
    this.logger.log({ workOrderId: id }, 'work order rescheduled');
    await this.notifyWoScheduled(rescheduled);
    return toWorkOrderResponse(rescheduled);
  }

  /** A work order that can still be acted on (not done/cancelled). */
  private async requireOpen(id: string): Promise<WorkOrder> {
    const wo = await this.repo.findById(id);
    if (!wo) throw new NotFoundException('work order not found');
    if (wo.status === 'done' || wo.status === 'cancelled') {
      throw new BadRequestException(`work order is already ${wo.status}`);
    }
    return wo;
  }

  // Hand an ONU to the subscriber and return its serial, or null when stock is dry (the connection
  // then uses a synthetic serial). The WO id is recorded on the movement (ADR-0003/0009).
  //
  // A serial scanned in the field (P3.B.3) is consumed instead of the FIFO pick; if it isn't in
  // warehouse stock it is used as-is — field evidence beats a fabricated fallback.
  //
  // Idempotent: `inventory.move` is not, so a retry would consume a second unit.
  // `alreadyAssignedSerial` (read once by `complete()`) short-circuits to the serial already assigned.
  private async assignOnu(
    customerName: string,
    workOrderId: string,
    scannedSerial: string | undefined,
    alreadyAssignedSerial: string | null,
  ): Promise<string | null> {
    if (alreadyAssignedSerial) {
      this.logger.log(
        { workOrderId, serial: alreadyAssignedSerial },
        'ONU already consumed for this work order — skipping (cascade retry)',
      );
      return alreadyAssignedSerial;
    }

    if (scannedSerial) {
      const scanned = await this.inventory.findBySerial(scannedSerial);
      if (scanned && scanned.status === 'warehouse') {
        await this.inventory.move(scanned.id, { type: 'assign', note: customerName, workOrderId });
        return scanned.serial;
      }
      this.logger.warn(
        { customerName, scannedSerial },
        'scanned ONU serial not in warehouse stock — using it as-is',
      );
      return scannedSerial;
    }

    const onu = await this.inventory.findAvailableOnu();
    if (!onu) {
      this.logger.warn({ customerName }, 'no ONU in stock — using synthetic serial');
      return null;
    }
    await this.inventory.move(onu.id, { type: 'assign', note: customerName, workOrderId });
    return onu.serial;
  }

  // Create the PPPoE secret on the default router, matching the plan profile. Skipped (logged)
  // when no router/profile exists.
  //
  // Idempotent: the install cascade is not transactional, so a retry re-enters here; without the
  // existing-secret check it would insert a second secret and double-increment `secretCount`.
  private async provisionSecret(customer: CustomerRow): Promise<void> {
    const existing = await this.secrets.findByCustomerId(customer.id);
    if (existing) {
      this.logger.log(
        { customerId: customer.id, secretId: existing.id },
        'PPPoE secret already provisioned — skipping (cascade retry)',
      );
      return;
    }

    const router = await this.routers.findFirst();
    if (!router) {
      this.logger.warn({ customerId: customer.id }, 'no router — skipping PPPoE secret');
      return;
    }
    const { items: profiles } = await this.profiles.listByRouter(router.id);
    const profile = profiles.find((p) => p.name === customer.planName) ?? profiles[0];
    if (!profile) {
      this.logger.warn({ routerId: router.id }, 'no PPPoE profile — skipping secret');
      return;
    }
    await this.secrets.create({
      routerId: router.id,
      username: pppoeUsername(customer.customerNo),
      profileId: profile.id,
      profileName: profile.name,
      customerId: customer.id,
      customerName: customer.fullName,
    });
    await this.routers.adjustSecretCount(router.id, 1);
  }

  /** Dispatch a repair WO from a ticket, linked back so completing it auto-resolves the ticket (P3.B.4). */
  async createFromTicket(input: {
    ticketId: string;
    customerId: string | null;
    customerName: string;
  }): Promise<WorkOrderResponse> {
    const wo = await this.repo.create({
      type: 'repair',
      ticketId: input.ticketId,
      customerId: input.customerId,
      customerName: input.customerName,
      technician: null,
      scheduledAt: new Date(Date.now() + REPAIR_LEAD_MS),
    });
    this.logger.log(
      { workOrderId: wo.id, ticketId: input.ticketId },
      'work order created from ticket',
    );
    await this.notifyWoScheduled(wo);
    return toWorkOrderResponse(wo);
  }

  /** Schedule an install WO from onboarding, with the technician and date chosen in the wizard. */
  async scheduleInstallForCustomer(input: {
    customerId: string;
    customerName: string;
    technician: string;
    scheduledAt: Date;
  }): Promise<WorkOrderResponse> {
    const wo = await this.repo.create({
      type: 'install',
      customerId: input.customerId,
      customerName: input.customerName,
      technician: input.technician,
      scheduledAt: input.scheduledAt,
    });
    this.logger.log(
      { workOrderId: wo.id, customerId: input.customerId },
      'install scheduled from onboarding',
    );
    await this.notifyWoScheduled(wo);
    return toWorkOrderResponse(wo);
  }

  /**
   * Schedule an install WO for a freshly-converted lead. customerId is required so completion runs
   * the activation cascade (ADR-0009); technician is null and the date defaults to a two-day lead.
   */
  async scheduleInstall(input: {
    customerId: string;
    customerName: string;
  }): Promise<WorkOrderResponse> {
    const wo = await this.repo.create({
      type: 'install',
      customerId: input.customerId,
      customerName: input.customerName,
      technician: null,
      scheduledAt: new Date(Date.now() + INSTALL_LEAD_MS),
    });
    this.logger.log(
      { workOrderId: wo.id, customerId: input.customerId },
      'install scheduled from lead',
    );
    await this.notifyWoScheduled(wo);
    return toWorkOrderResponse(wo);
  }

  /**
   * Notify the customer of a (re)scheduled WO (wo_scheduled, ADR-0012). jobId includes the exact
   * scheduledAt, so a reschedule sends a fresh notice but a re-run never double-sends. No-op without
   * a linked customer or phone. Best-effort: a queue outage must not fail the committed WO write.
   */
  private async notifyWoScheduled(wo: WorkOrder): Promise<void> {
    await notifyBestEffort(
      this.logger,
      async () => {
        if (!wo.customerId) return;
        const customer = await this.customers.findById(wo.customerId);
        if (!customer?.phone) return;
        await this.notifications.enqueue(
          {
            event: 'wo_scheduled',
            to: customer.phone,
            vars: {
              nama: customer.fullName,
              tipe: woTypeLabel(wo.type),
              kode: wo.code,
              jadwal: wo.scheduledAt.toISOString(),
            },
          },
          `wo_scheduled:${wo.id}:${wo.scheduledAt.toISOString()}`,
        );
      },
      { event: 'wo_scheduled', workOrderId: wo.id },
    );
  }

  /**
   * Notify the customer their WO is done (wo_done, ADR-0012). jobId is per WO id: a WO reaches
   * `done` once (early return in `complete()`). Best-effort: see `notifyWoScheduled`.
   */
  private async notifyWoDone(wo: WorkOrder): Promise<void> {
    await notifyBestEffort(
      this.logger,
      async () => {
        if (!wo.customerId) return;
        const customer = await this.customers.findById(wo.customerId);
        if (!customer?.phone) return;
        await this.notifications.enqueue(
          {
            event: 'wo_done',
            to: customer.phone,
            vars: {
              nama: customer.fullName,
              tipe: woTypeLabel(wo.type),
              kode: wo.code,
              selesai: (wo.completedAt ?? new Date()).toISOString(),
            },
          },
          `wo_done:${wo.id}`,
        );
      },
      { event: 'wo_done', workOrderId: wo.id },
    );
  }
}

// Human-readable (Indonesian) WO type label for notification vars.
function woTypeLabel(type: WorkOrder['type']): string {
  switch (type) {
    case 'install':
      return 'instalasi';
    case 'repair':
      return 'perbaikan';
    case 'dismantle':
      return 'pencabutan';
  }
}

// PPPoE login derived from the account number — shared by the connection
// record and the router secret so the two always agree.
function pppoeUsername(customerNo: string): string {
  return customerNo.toLowerCase().replace('-', '');
}

// Deterministic from the account number so a retry yields the same values. The ONU serial falls
// back to a synthetic one when stock is empty; rxPower prefers the field-measured value (P3.B.3).
function buildConnection(
  customer: { customerNo: string; planName: string },
  onuSerial: string | null,
  measuredRxPower?: number,
): CustomerConnection {
  const n = Number(customer.customerNo.replace(/\D/g, '')) || 0;
  return {
    type: 'gpon',
    pppoeUsername: pppoeUsername(customer.customerNo),
    profile: customer.planName,
    ipAddress: `100.64.${100 + (n % 150)}.2`,
    onuSerial: onuSerial ?? `ZTEG${20_000_000 + (n % 100_000)}`,
    olt: 'OLT-1',
    ponPort: `0/${n % 8}/${n % 16}`,
    rxPower: measuredRxPower ?? -20 - (n % 6),
  };
}

// Field-completion evidence, written on the same UPDATE as the done transition (P3.B.3).
// `technician` on the input is not persisted (no column); `notes` goes to completionNotes.
function buildCompletion(author: string, data?: CompleteWorkOrderInput): WorkOrderCompletion {
  return {
    scannedOnuSerial: data?.onuSerial ?? null,
    measuredRxPower: data?.rxPower ?? null,
    photos: data?.photos ?? null,
    signatureUrl: data?.signatureUrl ?? null,
    gpsLat: data?.gps?.lat ?? null,
    gpsLng: data?.gps?.lng ?? null,
    completionNotes: data?.notes ?? null,
    completedAt: new Date(),
    completedBy: author,
  };
}

function toWorkOrderResponse(row: WorkOrder): WorkOrderResponse {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    customerId: row.customerId,
    customerName: row.customerName,
    technician: row.technician,
    scheduledAt: row.scheduledAt.toISOString(),
    status: row.status,
    ticketId: row.ticketId,
    createdAt: row.createdAt.toISOString(),
    scannedOnuSerial: row.scannedOnuSerial,
    measuredRxPower: row.measuredRxPower,
    photos: row.photos ?? null,
    signatureUrl: row.signatureUrl,
    gpsLat: row.gpsLat,
    gpsLng: row.gpsLng,
    completionNotes: row.completionNotes,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completedBy: row.completedBy,
  };
}
