import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewPppSecret,
  type PppSecret,
  pppSecrets,
} from '../../infrastructure/database/schema/pppoe.schema';

type SecretPatch = Partial<
  Pick<
    NewPppSecret,
    | 'username'
    | 'profileId'
    | 'profileName'
    | 'customerId'
    | 'customerName'
    | 'disabled'
    | 'comment'
  >
>;

export interface SecretListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort secrets on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `asc(pppSecrets.username)` via buildOrderBy.
const SECRETS_SORT_WHITELIST = {
  username: pppSecrets.username,
  profileName: pppSecrets.profileName,
  customerName: pppSecrets.customerName,
  disabled: pppSecrets.disabled,
} satisfies Record<string, (typeof pppSecrets)[keyof typeof pppSecrets]>;

/**
 * The only place that talks to the `ppp_secrets` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class SecretsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async listByRouter(
    routerId: string,
    filter?: SecretListFilter,
  ): Promise<{ items: PppSecret[]; total: number }> {
    const where = and(
      eq(pppSecrets.routerId, routerId),
      filter?.q
        ? or(
            ilike(pppSecrets.username, `%${filter.q}%`),
            ilike(pppSecrets.customerName, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter?.sort,
      filter?.order,
      SECRETS_SORT_WHITELIST,
      asc(pppSecrets.username),
    );

    // If no pagination filter supplied (internal callers such as SessionsService),
    // return all rows ordered by username — preserving the previous contract.
    if (!filter) {
      const items = await this.db
        .select()
        .from(pppSecrets)
        .where(where)
        .orderBy(asc(pppSecrets.username));
      return { items, total: items.length };
    }

    const items = await this.db
      .select()
      .from(pppSecrets)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [countRow] = await this.db.select({ value: count() }).from(pppSecrets).where(where);

    return { items, total: countRow?.value ?? 0 };
  }

  async findById(id: string): Promise<PppSecret | null> {
    const [row] = await this.db.select().from(pppSecrets).where(eq(pppSecrets.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewPppSecret): Promise<PppSecret> {
    const [row] = await this.db.insert(pppSecrets).values(input).returning();
    if (!row) {
      throw new Error('ppp_secrets.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: SecretPatch): Promise<PppSecret> {
    const [row] = await this.db
      .update(pppSecrets)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(pppSecrets.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('secret not found');
    }
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(pppSecrets).where(eq(pppSecrets.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('secret not found');
    }
  }

  /**
   * Network enforcement for the billing lifecycle (ADR-0008): flip the
   * `disabled` flag on every PPPoE secret owned by a customer. Isolir/berhenti
   * disables (cuts the PPPoE session); reactivation re-enables. Idempotent and
   * a no-op (returns 0) while the customer has no secret provisioned yet
   * (prospek/instalasi), so callers never need to guard on it.
   */
  async setDisabledByCustomerId(customerId: string, disabled: boolean): Promise<number> {
    const rows = await this.db
      .update(pppSecrets)
      .set({ disabled, updatedAt: sql`now()` })
      .where(eq(pppSecrets.customerId, customerId))
      .returning({ id: pppSecrets.id });
    return rows.length;
  }
}
