import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, desc, eq, sql } from 'drizzle-orm';
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
  status?: Ticket['status'];
  limit: number;
  offset: number;
}

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
    const where = filter.status ? eq(tickets.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(tickets)
      .where(where)
      .orderBy(desc(tickets.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(tickets).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<Ticket | null> {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    return row ?? null;
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
