import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { CustomerConnection } from '../../infrastructure/database/schema/customers.schema';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { type CustomerRow, CustomersRepository } from '../customers/customers.repository';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { RoutersRepository } from '../routers/routers.repository';
// Only used to close the repair loop on complete() (P3.B.4). TicketsModule
// imports WorkOrdersModule (to dispatch a repair WO), so this edge needs
// forwardRef() on both sides — see work-orders.module.ts.
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
  ) {}

  async list(filter: WorkOrderListFilter): Promise<WorkOrderListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toWorkOrderResponse), total, summary };
  }

  /**
   * Complete a work order. For an install with a linked subscriber this
   * runs the full activation cascade:
   *   1. consume an ONU from warehouse stock (assign it to the subscriber),
   *   2. activate the customer + attach the provisioned GPON connection,
   *   3. provision a PPPoE secret on the default router,
   *   4. issue the first invoice.
   * Idempotent — a done order returns unchanged with no re-provisioning.
   *
   * Each external step degrades gracefully: with no ONU in stock the
   * connection falls back to a synthetic serial; with no router/profile the
   * secret is skipped (logged). The customer is always activated and billed.
   *
   * For a repair WO linked to a ticket (P3.B.4), completion also closes the
   * repair loop: the linked ticket is auto-resolved (or marked breached if
   * past its SLA deadline). Because this whole method no-ops on an
   * already-done order, that ticket close fires exactly once.
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
      // An install order must carry its subscriber. Completing one without it
      // used to silently skip activation + provisioning + first invoice, which
      // is exactly the lead-convert break this guards against (ADR-0009).
      if (!wo.customerId) {
        throw new BadRequestException('install work order is not linked to a customer');
      }
      const customer = await this.customers.findById(wo.customerId);
      if (customer) {
        const onuSerial = await this.assignOnu(customer.fullName, wo.id, data?.onuSerial);
        await this.customers.markInstalled(
          wo.customerId,
          buildConnection(customer, onuSerial, data?.rxPower),
        );
        await this.provisionSecret(customer);
        await this.invoices.generateFirstInvoice(wo.customerId);
      }
    }

    const done = await this.repo.markDone(id, buildCompletion(author, data));
    this.logger.log({ workOrderId: id, type: wo.type }, 'work order completed');

    if (wo.type === 'repair' && wo.ticketId) {
      await this.tickets.resolveFromWorkOrder(wo.ticketId, done.code, author);
    }

    return toWorkOrderResponse(done);
  }

  /**
   * Start a scheduled order (→ in_progress). P3.B.2 — this transition was
   * unreachable via the API before. Idempotent if already in progress.
   */
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

  // Hand an ONU to the subscriber and return its serial, or null when stock
  // is dry (the connection then uses a synthetic serial). The work order id
  // is recorded on the movement so stock consumption reconciles with the
  // order (ADR-0003/0009).
  //
  // When the technician scanned a real serial in the field (P3.B.3), that
  // exact unit is consumed instead of the FIFO pick: if it's in warehouse
  // stock, it's assigned like any other pick; if it's not (unknown asset, or
  // already consumed elsewhere), the scanned serial is still used as-is —
  // real field evidence beats a fabricated fallback.
  private async assignOnu(
    customerName: string,
    workOrderId: string,
    scannedSerial?: string,
  ): Promise<string | null> {
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

  // Create the subscriber's PPPoE secret on the default router, matching the
  // plan profile when present. Skipped (logged) when no router/profile exists.
  private async provisionSecret(customer: CustomerRow): Promise<void> {
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

  /**
   * Dispatch a repair work order from a support ticket, linked back to it
   * (P3.B.4) so completing the order can auto-resolve the ticket.
   */
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
    return toWorkOrderResponse(wo);
  }

  /**
   * Schedule an install work order from onboarding — linked to the new
   * subscriber, with the technician and install date chosen in the wizard.
   */
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
    return toWorkOrderResponse(wo);
  }

  /**
   * Schedule an install work order for a freshly-converted lead, LINKED to the
   * new subscriber. customerId is required so completing the order runs the
   * activation cascade (ADR-0009); the technician + exact date are filled in
   * by the field team later, so they default to null / a two-day lead time.
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
    return toWorkOrderResponse(wo);
  }
}

// PPPoE login derived from the account number — shared by the connection
// record and the router secret so the two always agree.
function pppoeUsername(customerNo: string): string {
  return customerNo.toLowerCase().replace('-', '');
}

// Provisioned GPON connection derived deterministically from the
// subscriber's account number, so a retry yields the same values. The ONU
// serial comes from the assigned inventory item; it falls back to a
// synthetic serial when warehouse stock is empty. rxPower uses the RX
// measured in the field (P3.B.3) when the technician supplied one; otherwise
// it falls back to the same deterministic placeholder as before.
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

// Field-completion evidence written on the same UPDATE as the done
// transition (P3.B.3). completedAt/completedBy are always set (every
// completion has an author and a timestamp); the rest stay null when the
// technician submitted no field kit. `technician` on the input is accepted
// for forward-compat with the field-completion form but is not persisted
// yet — no column exists for it. `notes` (the "Catatan" free-text field the
// technician fills in on the completion form) IS persisted, into
// completionNotes.
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
