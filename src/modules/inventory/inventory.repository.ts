import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type InventoryItem,
  type NewInventoryItem,
  type NewStockMovement,
  type StockMovement,
  inventoryItems,
  stockMovements,
} from '../../infrastructure/database/schema/inventory.schema';

// Columns the caller may sort movements on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `at desc` via buildOrderBy — never throws.
const MOVEMENT_SORT_WHITELIST = {
  at: stockMovements.at,
  serial: stockMovements.serial,
  type: stockMovements.type,
  kind: stockMovements.kind,
} satisfies Record<string, (typeof stockMovements)[keyof typeof stockMovements]>;

export interface InventoryListFilter {
  q?: string;
  status?: InventoryItem['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const SORT_WHITELIST = {
  serial: inventoryItems.serial,
  status: inventoryItems.status,
  kind: inventoryItems.kind,
  createdAt: inventoryItems.createdAt,
} satisfies Record<string, (typeof inventoryItems)[keyof typeof inventoryItems]>;

export interface MovementListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Fields a PATCH may correct directly (no movement logged).
export type InventoryPatch = Partial<
  Pick<NewInventoryItem, 'kind' | 'serial' | 'status' | 'assignedTo' | 'assignedCustomerId'>
>;

export type InventoryStatus = InventoryItem['status'];

export interface InventoryUpdateOptions {
  // Only update while the row still has this status (compare-and-set).
  expectedStatus?: InventoryStatus;
}

/**
 * The only place that talks to `inventory_items` / `stock_movements`.
 * Returns domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: InventoryListFilter): Promise<{ items: InventoryItem[]; total: number }> {
    const where = and(
      filter.status ? eq(inventoryItems.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(inventoryItems.serial, `%${filter.q}%`),
            ilike(inventoryItems.assignedTo, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      SORT_WHITELIST,
      desc(inventoryItems.createdAt),
    );

    const items = await this.db
      .select()
      .from(inventoryItems)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(inventoryItems).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<InventoryItem | null> {
    const [row] = await this.db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, id))
      .limit(1);
    return row ?? null;
  }

  // Look up a specific item by its physical serial — used to consume the
  // exact ONU a technician scanned in the field (P3.B.3) rather than
  // whatever the FIFO pick would have returned.
  async findBySerial(serial: string): Promise<InventoryItem | null> {
    const [row] = await this.db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.serial, serial))
      .limit(1);
    return row ?? null;
  }

  // The next ONU available to hand out: oldest warehouse stock first
  // (FIFO), so the install cascade consumes physical inventory deterministically.
  // Deliberately unlocked: the conditional UPDATE in `update(..., { expectedStatus })` is the guard.
  async findAvailableOnu(): Promise<InventoryItem | null> {
    const [row] = await this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.kind, 'onu'), eq(inventoryItems.status, 'warehouse')))
      .orderBy(asc(inventoryItems.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * The serial already consumed for a given work order's `assign` movement,
   * or null when none has been recorded yet. Used by the install cascade
   * (`WorkOrdersService.assignOnu`) to make ONU consumption idempotent
   * across a retry of `complete()`: without this, a retry after a
   * mid-cascade failure (e.g. `provisionSecret`/`generateFirstInvoice`
   * throwing) would re-run the FIFO pick and consume a SECOND ONU for the
   * same order. Reads the movement ledger's denormalized `serial` directly
   * (no join needed — see `stockMovements`' comment) and takes the most
   * recent `assign` movement for the order, matching how the ledger is
   * otherwise read.
   */
  async findAssignedSerialForWorkOrder(workOrderId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ serial: stockMovements.serial })
      .from(stockMovements)
      .where(and(eq(stockMovements.workOrderId, workOrderId), eq(stockMovements.type, 'assign')))
      .orderBy(desc(stockMovements.at))
      .limit(1);
    return row?.serial ?? null;
  }

  async create(input: NewInventoryItem): Promise<InventoryItem> {
    const [row] = await this.db.insert(inventoryItems).values(input).returning();
    if (!row) {
      throw new Error('inventory_items.insert returned no row');
    }
    return row;
  }

  async update(
    id: string,
    patch: InventoryPatch,
    opts?: InventoryUpdateOptions,
  ): Promise<InventoryItem> {
    const expectedStatus = opts?.expectedStatus;
    const [row] = await this.db
      .update(inventoryItems)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(inventoryItems.id, id),
          expectedStatus ? eq(inventoryItems.status, expectedStatus) : undefined,
        ),
      )
      .returning();
    if (!row && expectedStatus) {
      throw new ConflictException(
        'ONU sudah dipakai atau tidak lagi di gudang — muat ulang lalu coba lagi',
      );
    }
    if (!row) {
      throw new NotFoundException('inventory item not found');
    }
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(inventoryItems).where(eq(inventoryItems.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('inventory item not found');
    }
  }

  // --- Movements ledger -----------------------------------------------

  async addMovement(input: NewStockMovement): Promise<StockMovement> {
    const [row] = await this.db.insert(stockMovements).values(input).returning();
    if (!row) {
      throw new Error('stock_movements.insert returned no row');
    }
    return row;
  }

  async listMovements(
    filter: MovementListFilter,
  ): Promise<{ items: StockMovement[]; total: number }> {
    const where = filter.q
      ? or(
          ilike(stockMovements.serial, `%${filter.q}%`),
          ilike(stockMovements.note, `%${filter.q}%`),
        )
      : undefined;

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      MOVEMENT_SORT_WHITELIST,
      desc(stockMovements.at),
    );

    const items = await this.db
      .select()
      .from(stockMovements)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(stockMovements).where(where);
    return { items, total: totals?.value ?? 0 };
  }
}
