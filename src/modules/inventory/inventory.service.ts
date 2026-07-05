import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  InventoryItem,
  StockMovement,
} from '../../infrastructure/database/schema/inventory.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { InventoryItemResponse, StockMovementResponse } from './dto/inventory-response.dto';
import type { MoveInventoryInput } from './dto/move-inventory.dto';
import type { StockInInput } from './dto/stock-in.dto';
import type { UpdateInventoryInput } from './dto/update-inventory.dto';
import {
  type InventoryListFilter,
  type InventoryPatch,
  InventoryRepository,
  type MovementListFilter,
} from './inventory.repository';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly repo: InventoryRepository,
    // Resolve the subscriber id from the assigned name.
    private readonly customers: CustomersRepository,
  ) {}

  async list(
    filter: InventoryListFilter,
  ): Promise<{ items: InventoryItemResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toItemResponse), total };
  }

  async listMovements(
    filter: MovementListFilter,
  ): Promise<{ items: StockMovementResponse[]; total: number }> {
    const { items, total } = await this.repo.listMovements(filter);
    return { items: items.map(toMovementResponse), total };
  }

  /**
   * The next ONU available to assign, or null when warehouse stock is dry.
   * Used by the work-order install cascade to consume real inventory.
   */
  async findAvailableOnu(): Promise<InventoryItem | null> {
    return this.repo.findAvailableOnu();
  }

  /**
   * Look up a specific ONU by its physical serial — used by the work-order
   * install cascade to consume the exact unit a technician scanned in the
   * field (P3.B.3), instead of the FIFO pick from `findAvailableOnu`.
   */
  async findBySerial(serial: string): Promise<InventoryItem | null> {
    return this.repo.findBySerial(serial);
  }

  /** Register a new item into the warehouse and log an `in` movement. */
  async stockIn(input: StockInInput): Promise<InventoryItemResponse> {
    const item = await this.repo.create({ kind: input.kind, serial: input.serial });
    await this.repo.addMovement({
      itemId: item.id,
      serial: item.serial,
      kind: item.kind,
      type: 'in',
      note: 'Stok masuk',
    });
    this.logger.log({ itemId: item.id }, 'stock in');
    return toItemResponse(item);
  }

  /** Transition an item (assign / return / broken) and log the movement. */
  async move(id: string, input: MoveInventoryInput): Promise<InventoryItemResponse> {
    const item = await this.repo.findById(id);
    if (!item) throw new NotFoundException('inventory item not found');

    let patch: InventoryPatch;
    let note: string;
    if (input.type === 'assign') {
      const assignedTo = input.note ?? item.assignedTo;
      const assignedCustomerId = assignedTo
        ? await this.customers.findIdByFullName(assignedTo)
        : null;
      patch = { status: 'installed', assignedTo, assignedCustomerId };
      note = assignedTo ?? '';
    } else if (input.type === 'return') {
      patch = { status: 'warehouse', assignedTo: null, assignedCustomerId: null };
      note = input.note ?? 'Dikembalikan ke gudang';
    } else {
      patch = { status: 'broken' };
      note = input.note ?? 'Rusak';
    }

    const updated = await this.repo.update(id, patch);
    await this.repo.addMovement({
      itemId: updated.id,
      serial: updated.serial,
      kind: updated.kind,
      type: input.type,
      note,
      // Link the movement to its driving work order when one is supplied
      // (the install cascade passes it), so stock reconciles with the order.
      workOrderId: input.workOrderId ?? null,
    });
    this.logger.log(
      { itemId: id, type: input.type, workOrderId: input.workOrderId },
      'inventory moved',
    );
    return toItemResponse(updated);
  }

  /** Correct item fields directly (no movement logged). */
  async update(id: string, input: UpdateInventoryInput): Promise<InventoryItemResponse> {
    const patch: InventoryPatch = {};
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.serial !== undefined) patch.serial = input.serial;
    if (input.status !== undefined) patch.status = input.status;
    if (input.assignedTo !== undefined) {
      patch.assignedTo = input.assignedTo;
      patch.assignedCustomerId = input.assignedTo
        ? await this.customers.findIdByFullName(input.assignedTo)
        : null;
    }
    const updated = await this.repo.update(id, patch);
    return toItemResponse(updated);
  }

  async remove(id: string): Promise<void> {
    await this.repo.remove(id);
  }
}

function toItemResponse(row: InventoryItem): InventoryItemResponse {
  return {
    id: row.id,
    kind: row.kind,
    serial: row.serial,
    status: row.status,
    assignedTo: row.assignedTo,
    assignedCustomerId: row.assignedCustomerId,
  };
}

function toMovementResponse(row: StockMovement): StockMovementResponse {
  return {
    id: row.id,
    itemId: row.itemId,
    serial: row.serial,
    kind: row.kind,
    type: row.type,
    note: row.note,
    at: row.at.toISOString(),
  };
}
