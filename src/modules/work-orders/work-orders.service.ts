import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CustomerConnection } from '../../infrastructure/database/schema/customers.schema';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InvoicesService } from '../invoices/invoices.service';
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
  ) {}

  async list(filter: WorkOrderListFilter): Promise<{ items: WorkOrderResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toWorkOrderResponse), total };
  }

  /**
   * Complete a work order. For an install with a linked subscriber this
   * runs the activation cascade: activate the customer + attach a
   * provisioned GPON connection, then issue the first invoice. Idempotent
   * — a done order returns unchanged with no re-provisioning.
   *
   * NOTE: ONU-from-inventory consumption and the PPPoE secret on the
   * Mikrotik router are part of the full FE cascade but are deferred until
   * the inventory and routers modules exist; the connection here carries a
   * synthetic ONU serial in the meantime.
   */
  async complete(id: string): Promise<WorkOrderResponse> {
    const wo = await this.repo.findById(id);
    if (!wo) throw new NotFoundException('work order not found');
    if (wo.status === 'done') {
      return toWorkOrderResponse(wo);
    }

    if (wo.type === 'install' && wo.customerId) {
      const customer = await this.customers.findById(wo.customerId);
      if (customer) {
        await this.customers.markInstalled(wo.customerId, buildConnection(customer));
        await this.invoices.generateFirstInvoice(wo.customerId);
      }
    }

    const done = await this.repo.markDone(id);
    this.logger.log({ workOrderId: id, type: wo.type }, 'work order completed');
    return toWorkOrderResponse(done);
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
   * Schedule an install work order for a freshly-converted lead. customerId
   * is null — the subscriber is linked when onboarding completes (matches
   * the FE convert flow).
   */
  async scheduleInstall(customerName: string): Promise<WorkOrderResponse> {
    const wo = await this.repo.create({
      type: 'install',
      customerId: null,
      customerName,
      technician: null,
      scheduledAt: new Date(Date.now() + INSTALL_LEAD_MS),
    });
    this.logger.log({ workOrderId: wo.id }, 'install scheduled from lead');
    return toWorkOrderResponse(wo);
  }
}

// Provisioned GPON connection derived deterministically from the
// subscriber's account number, so a retry yields the same values.
function buildConnection(customer: {
  customerNo: string;
  planName: string;
}): CustomerConnection {
  const n = Number(customer.customerNo.replace(/\D/g, '')) || 0;
  return {
    type: 'gpon',
    pppoeUsername: customer.customerNo.toLowerCase().replace('-', ''),
    profile: customer.planName,
    ipAddress: `100.64.${100 + (n % 150)}.2`,
    onuSerial: `ZTEG${20_000_000 + (n % 100_000)}`,
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
