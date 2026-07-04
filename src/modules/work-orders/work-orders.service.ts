import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CustomerConnection } from '../../infrastructure/database/schema/customers.schema';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { type CustomerRow, CustomersRepository } from '../customers/customers.repository';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { RoutersRepository } from '../routers/routers.repository';
import type { WorkOrderResponse } from './dto/work-order-response.dto';
import { type WorkOrderListFilter, WorkOrdersRepository } from './work-orders.repository';

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
  ) {}

  async list(filter: WorkOrderListFilter): Promise<{ items: WorkOrderResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toWorkOrderResponse), total };
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
   */
  async complete(id: string): Promise<WorkOrderResponse> {
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
        const onuSerial = await this.assignOnu(customer.fullName);
        await this.customers.markInstalled(wo.customerId, buildConnection(customer, onuSerial));
        await this.provisionSecret(customer);
        await this.invoices.generateFirstInvoice(wo.customerId);
      }
    }

    const done = await this.repo.markDone(id);
    this.logger.log({ workOrderId: id, type: wo.type }, 'work order completed');
    return toWorkOrderResponse(done);
  }

  // Hand the oldest warehouse ONU to the subscriber and return its serial,
  // or null when stock is dry (the connection then uses a synthetic serial).
  private async assignOnu(customerName: string): Promise<string | null> {
    const onu = await this.inventory.findAvailableOnu();
    if (!onu) {
      this.logger.warn({ customerName }, 'no ONU in stock — using synthetic serial');
      return null;
    }
    await this.inventory.move(onu.id, { type: 'assign', note: customerName });
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

  /** Dispatch a repair work order from a support ticket. */
  async createFromTicket(input: {
    customerId: string | null;
    customerName: string;
  }): Promise<WorkOrderResponse> {
    const wo = await this.repo.create({
      type: 'repair',
      customerId: input.customerId,
      customerName: input.customerName,
      technician: null,
      scheduledAt: new Date(Date.now() + REPAIR_LEAD_MS),
    });
    this.logger.log({ workOrderId: wo.id }, 'work order created from ticket');
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
// synthetic serial when warehouse stock is empty.
function buildConnection(
  customer: { customerNo: string; planName: string },
  onuSerial: string | null,
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
    rxPower: -20 - (n % 6),
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
    createdAt: row.createdAt.toISOString(),
  };
}
