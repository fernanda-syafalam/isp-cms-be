import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewWorkOrder,
  type WorkOrder,
  workOrders,
} from '../../infrastructure/database/schema/work-orders.schema';
import type { WorkOrderSummary } from './dto/work-order-response.dto';

export interface WorkOrderListFilter {
  q?: string;
  status?: WorkOrder['status'];
  type?: WorkOrder['type'];
  // Exact-match technician filter — powers the teknisi "Tugas saya" view
  // (P3.B.1). Assignee is still free text (a real user FK is a later item).
  technician?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// State-machine mutable fields (P3.B.2). The service enforces legal
// transitions before calling patch(); this is only the shape.
export type WorkOrderPatch = Partial<Pick<NewWorkOrder, 'status' | 'technician' | 'scheduledAt'>>;

// Field-completion evidence written alongside the done transition (P3.B.3):
// the scanned ONU serial, measured RX power, photos, signature, GPS, and who
// completed it and when. All optional — a WO completed with no field kit
// still gets completedAt/completedBy, the rest stay null.
export type WorkOrderCompletion = Partial<
  Pick<
    NewWorkOrder,
    | 'scannedOnuSerial'
    | 'measuredRxPower'
    | 'photos'
    | 'signatureUrl'
    | 'gpsLat'
    | 'gpsLng'
    | 'completionNotes'
    | 'completedAt'
    | 'completedBy'
  >
>;

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const SORT_WHITELIST = {
  code: workOrders.code,
  scheduledAt: workOrders.scheduledAt,
  status: workOrders.status,
  createdAt: workOrders.createdAt,
} satisfies Record<string, (typeof workOrders)[keyof typeof workOrders]>;

/**
 * The only place that talks to the `work_orders` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class WorkOrdersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: WorkOrderListFilter,
  ): Promise<{ items: WorkOrder[]; total: number; summary: WorkOrderSummary }> {
    const where = and(
      filter.status ? eq(workOrders.status, filter.status) : undefined,
      filter.type ? eq(workOrders.type, filter.type) : undefined,
      filter.technician ? eq(workOrders.technician, filter.technician) : undefined,
      filter.q
        ? or(
            ilike(workOrders.code, `%${filter.q}%`),
            ilike(workOrders.customerName, `%${filter.q}%`),
            ilike(workOrders.technician, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      SORT_WHITELIST,
      desc(workOrders.createdAt),
    );

    const items = await this.db
      .select()
      .from(workOrders)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(workOrders).where(where);

    // Full-set status-count rollup — computed over ALL work orders, ignoring
    // status/type/q/technician/paging (mirrors the invoices summary
    // aggregate). A single grouped-filter aggregate avoids 4 separate
    // COUNT queries; missing statuses are zero-filled below since a fresh
    // table may have zero rows for a given status.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        scheduled: sql<number>`count(*) filter (where ${workOrders.status} = 'scheduled')`,
        inProgress: sql<number>`count(*) filter (where ${workOrders.status} = 'in_progress')`,
        done: sql<number>`count(*) filter (where ${workOrders.status} = 'done')`,
        cancelled: sql<number>`count(*) filter (where ${workOrders.status} = 'cancelled')`,
      })
      .from(workOrders);

    const summary: WorkOrderSummary = {
      total: summaryRow?.total ?? 0,
      byStatus: {
        scheduled: Number(summaryRow?.scheduled ?? 0),
        in_progress: Number(summaryRow?.inProgress ?? 0),
        done: Number(summaryRow?.done ?? 0),
        cancelled: Number(summaryRow?.cancelled ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  async findById(id: string): Promise<WorkOrder | null> {
    const [row] = await this.db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewWorkOrder): Promise<WorkOrder> {
    const [row] = await this.db.insert(workOrders).values(input).returning();
    if (!row) {
      throw new Error('work_orders.insert returned no row');
    }
    return row;
  }

  /**
   * Flip a work order to done, optionally writing field-completion evidence
   * (P3.B.3) in the SAME UPDATE so the status flip and the evidence capture
   * are atomic.
   */
  async markDone(id: string, completion?: WorkOrderCompletion): Promise<WorkOrder> {
    const [row] = await this.db
      .update(workOrders)
      .set({ ...completion, status: 'done', updatedAt: sql`now()` })
      .where(eq(workOrders.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('work order not found');
    }
    return row;
  }

  /**
   * Patch the mutable state-machine fields (status / technician / scheduledAt).
   * The service enforces the legal transitions; this is the DB gate (P3.B.2).
   */
  async patch(id: string, patch: WorkOrderPatch): Promise<WorkOrder> {
    const [row] = await this.db
      .update(workOrders)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(workOrders.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('work order not found');
    }
    return row;
  }
}
