import { Injectable, NotFoundException } from '@nestjs/common';
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

  // The next ONU available to hand out: oldest warehouse stock first
  // (FIFO), so the install cascade consumes physical inventory deterministically.
  async findAvailableOnu(): Promise<InventoryItem | null> {
    const [row] = await this.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.kind, 'onu'), eq(inventoryItems.status, 'warehouse')))
      .orderBy(asc(inventoryItems.createdAt))
      .limit(1);
    return row ?? null;
  }

  async create(input: NewInventoryItem): Promise<InventoryItem> {
    const [row] = await this.db.insert(inventoryItems).values(input).returning();
    if (!row) {
      throw new Error('inventory_items.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: InventoryPatch): Promise<InventoryItem> {
    const [row] = await this.db
      .update(inventoryItems)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(inventoryItems.id, id))
      .returning();
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
