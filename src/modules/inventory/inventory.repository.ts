import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type InventoryItem,
  type NewInventoryItem,
  type NewStockMovement,
  type StockMovement,
  inventoryItems,
  stockMovements,
} from '../../infrastructure/database/schema/inventory.schema';

export interface InventoryListFilter {
  status?: InventoryItem['status'];
  limit: number;
  offset: number;
}

export interface MovementListFilter {
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
    const where = filter.status ? eq(inventoryItems.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(inventoryItems)
      .where(where)
      .orderBy(desc(inventoryItems.createdAt))
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
    const items = await this.db
      .select()
      .from(stockMovements)
      .orderBy(desc(stockMovements.at))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(stockMovements);
    return { items, total: totals?.value ?? 0 };
  }
}
