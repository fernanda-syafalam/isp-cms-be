import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewTicket,
  type NewTicketEvent,
  type Ticket,
  type TicketEvent,
  ticketEvents,
  tickets,
} from '../../infrastructure/database/schema/tickets.schema';

export interface TicketListFilter {
  q?: string;
  status?: Ticket['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const SORT_WHITELIST = {
  code: tickets.code,
  status: tickets.status,
  priority: tickets.priority,
  slaDueAt: tickets.slaDueAt,
  createdAt: tickets.createdAt,
} satisfies Record<string, (typeof tickets)[keyof typeof tickets]>;

// Fields a PATCH may touch. status/priority/assignee/subject + the
// recomputed SLA deadline; everything else is owned by the service flow.
export type TicketPatch = Partial<
  Pick<NewTicket, 'subject' | 'priority' | 'status' | 'assignee' | 'slaDueAt'>
>;

/**
 * The only place that talks to `tickets` / `ticket_events`. Returns
 * domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class TicketsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: TicketListFilter): Promise<{ items: Ticket[]; total: number }> {
    const where = and(
      filter.status ? eq(tickets.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(tickets.code, `%${filter.q}%`),
            ilike(tickets.subject, `%${filter.q}%`),
            ilike(tickets.customerName, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      SORT_WHITELIST,
      desc(tickets.createdAt),
    );

    const items = await this.db
      .select()
      .from(tickets)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(tickets).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<Ticket | null> {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    return row ?? null;
  }

  // A single customer's tickets, newest first — the portal "me" snapshot.
  async listByCustomer(customerId: string): Promise<Ticket[]> {
    return this.db
      .select()
      .from(tickets)
      .where(eq(tickets.customerId, customerId))
      .orderBy(desc(tickets.createdAt));
  }

  // Resolve a ticket id from its human code (e.g. TKT-2001) — used when a
  // module references a ticket by code (SLA credits).
  async findIdByCode(code: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.code, code))
      .limit(1);
    return row?.id ?? null;
  }

  async create(input: NewTicket): Promise<Ticket> {
    const [row] = await this.db.insert(tickets).values(input).returning();
    if (!row) {
      throw new Error('tickets.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket> {
    const [row] = await this.db
      .update(tickets)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(tickets.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('ticket not found');
    }
    return row;
  }

  // --- Analytics support ----------------------------------------------

  /** Ticket counts grouped by status (every status present). Powers the
   * dashboard open-count, status breakdown, and SLA-compliance ratio. */
  async countByStatus(): Promise<Record<Ticket['status'], number>> {
    const rows = await this.db
      .select({ status: tickets.status, value: count() })
      .from(tickets)
      .groupBy(tickets.status);
    const result: Record<Ticket['status'], number> = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      breached: 0,
    };
    for (const row of rows) {
      result[row.status] = row.value;
    }
    return result;
  }

  // --- Timeline -------------------------------------------------------

  async addEvent(input: NewTicketEvent): Promise<TicketEvent> {
    const [row] = await this.db.insert(ticketEvents).values(input).returning();
    if (!row) {
      throw new Error('ticket_events.insert returned no row');
    }
    return row;
  }

  async listEvents(ticketId: string): Promise<{ items: TicketEvent[]; total: number }> {
    const items = await this.db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId))
      .orderBy(asc(ticketEvents.at));
    return { items, total: items.length };
  }
}
