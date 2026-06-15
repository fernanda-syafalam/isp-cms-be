import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Contract,
  type NewContract,
  contracts,
} from '../../infrastructure/database/schema/contracts.schema';

/**
 * The only place that talks to the `contracts` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class ContractsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async findByCustomerId(customerId: string): Promise<Contract | null> {
    const [row] = await this.db
      .select()
      .from(contracts)
      .where(eq(contracts.customerId, customerId))
      .limit(1);
    return row ?? null;
  }

  async create(input: NewContract): Promise<Contract> {
    const [row] = await this.db.insert(contracts).values(input).returning();
    if (!row) {
      throw new Error('contracts.insert returned no row');
    }
    return row;
  }

  async markSent(customerId: string): Promise<Contract> {
    const [row] = await this.db
      .update(contracts)
      .set({ status: 'sent', updatedAt: sql`now()` })
      .where(eq(contracts.customerId, customerId))
      .returning();
    if (!row) {
      throw new NotFoundException('contract not found');
    }
    return row;
  }

  // Sign + apply e-Meterai in one statement.
  async markSigned(customerId: string): Promise<Contract> {
    const [row] = await this.db
      .update(contracts)
      .set({ status: 'signed', meterai: true, signedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(contracts.customerId, customerId))
      .returning();
    if (!row) {
      throw new NotFoundException('contract not found');
    }
    return row;
  }
}
