import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import type { Ticket, TicketEvent } from '../../infrastructure/database/schema/tickets.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { WorkOrderResponse } from '../work-orders/dto/work-order-response.dto';
// WorkOrdersService now injects TicketsService back (P3.B.4, to close the
// repair loop on complete()) — a real two-file circular import, so this
// injection needs forwardRef() on both sides (see work-orders.service.ts).
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { AddCommentInput } from './dto/add-comment.dto';
import type { CreateTicketInput } from './dto/create-ticket.dto';
import type { TicketEventResponse } from './dto/ticket-event-response.dto';
import type { TicketResponse } from './dto/ticket-response.dto';
import type { UpdateTicketInput } from './dto/update-ticket.dto';
import { type TicketListFilter, type TicketPatch, TicketsRepository } from './tickets.repository';

// SLA response window per priority, in hours. Deadline = createdAt + this.
const SLA_HOURS: Record<Ticket['priority'], number> = {
  urgent: 4,
  high: 8,
  medium: 24,
  low: 72,
};

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly repo: TicketsRepository,
    // Resolve the subscriber id from the typed-in customer name.
    private readonly customers: CustomersRepository,
    // Dispatch a repair work order from a ticket.
    @Inject(forwardRef(() => WorkOrdersService))
    private readonly workOrders: WorkOrdersService,
  ) {}

  async list(filter: TicketListFilter): Promise<{ items: TicketResponse[]; total: number }> {
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toTicketResponse), total };
  }

  async findById(id: string): Promise<TicketResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('ticket not found');
    return toTicketResponse(row);
  }

  /** A customer's tickets, newest first — for the self-service portal. */
  async listByCustomer(customerId: string): Promise<TicketResponse[]> {
    const rows = await this.repo.listByCustomer(customerId);
    return rows.map(toTicketResponse);
  }

  async create(input: CreateTicketInput, author: string): Promise<TicketResponse> {
    const customerId = await this.customers.findIdByFullName(input.customerName);
    const createdAt = new Date();
    const slaDueAt = addHours(createdAt, SLA_HOURS[input.priority]);

    const ticket = await this.repo.create({
      subject: input.subject,
      customerName: input.customerName,
      priority: input.priority,
      customerId,
      slaDueAt,
      createdAt,
    });
    await this.repo.addEvent({
      ticketId: ticket.id,
      kind: 'created',
      author,
      body: 'Tiket dibuat',
    });
    this.logger.log({ ticketId: ticket.id }, 'ticket created');
    return toTicketResponse(ticket);
  }

  /**
   * Patch a ticket. A priority change recomputes the SLA deadline; an
   * assignee or status change appends a timeline event. Resolving a
   * ticket after its deadline records it as `breached`, not `resolved`.
   */
  async update(id: string, input: UpdateTicketInput, author: string): Promise<TicketResponse> {
    const ticket = await this.repo.findById(id);
    if (!ticket) throw new NotFoundException('ticket not found');

    const patch: TicketPatch = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.priority !== undefined) {
      patch.priority = input.priority;
      patch.slaDueAt = addHours(ticket.createdAt, SLA_HOURS[input.priority]);
    }

    const assigneeChanged = input.assignee !== undefined && input.assignee !== ticket.assignee;
    if (input.assignee !== undefined) patch.assignee = input.assignee;

    let nextStatus: Ticket['status'] | undefined;
    if (input.status !== undefined && input.status !== ticket.status) {
      nextStatus = this.downgradeIfBreached(ticket, input.status);
      patch.status = nextStatus;
    }

    const updated = await this.repo.update(id, patch);

    if (assigneeChanged) {
      await this.repo.addEvent({
        ticketId: id,
        kind: 'assign',
        author,
        body: input.assignee ? `Ditugaskan ke ${input.assignee}` : 'Assign dilepas',
      });
    }
    if (nextStatus) {
      await this.repo.addEvent({
        ticketId: id,
        kind: 'status',
        author,
        body: `Status → ${nextStatus}`,
      });
    }
    return toTicketResponse(updated);
  }

  /**
   * SLA breach scan (P2.1, every 15 min). Transitions open/in-progress
   * tickets past their deadline to `breached` and records a status event
   * per ticket as the escalation trail. Returns how many breached.
   */
  async scanSla(): Promise<{ breached: number }> {
    const breached = await this.repo.markBreachedPastSla(new Date());
    for (const ticket of breached) {
      await this.repo.addEvent({
        ticketId: ticket.id,
        kind: 'status',
        author: 'Sistem',
        body: 'SLA terlampaui → breached',
      });
    }
    if (breached.length > 0) {
      this.logger.log({ breached: breached.length }, 'sla scan marked breached');
    }
    return { breached: breached.length };
  }

  async addComment(id: string, input: AddCommentInput, author: string): Promise<void> {
    const ticket = await this.repo.findById(id);
    if (!ticket) throw new NotFoundException('ticket not found');
    await this.repo.addEvent({
      ticketId: id,
      kind: 'comment',
      author,
      body: input.body,
    });
  }

  /** Dispatch a repair work order from a ticket and log it on the timeline. */
  async createWorkOrder(id: string, author: string): Promise<WorkOrderResponse> {
    const ticket = await this.repo.findById(id);
    if (!ticket) throw new NotFoundException('ticket not found');
    const wo = await this.workOrders.createFromTicket({
      ticketId: ticket.id,
      customerId: ticket.customerId,
      customerName: ticket.customerName,
    });
    await this.repo.addEvent({
      ticketId: id,
      kind: 'workorder',
      author,
      body: `Work order ${wo.code} dibuat`,
    });
    return wo;
  }

  /**
   * Close the repair loop (P3.B.4): called by WorkOrdersService when a
   * repair WO linked to this ticket is completed. Idempotent — a ticket
   * that is already `resolved`/`breached` is left untouched, so a second
   * `complete()` call on the same WO (itself idempotent) never double-closes
   * it. Reuses the exact resolve-vs-breach rule from `update()`.
   */
  async resolveFromWorkOrder(ticketId: string, woCode: string, author: string): Promise<void> {
    const ticket = await this.repo.findById(ticketId);
    if (!ticket) throw new NotFoundException('ticket not found');
    if (ticket.status === 'resolved' || ticket.status === 'breached') return;

    await this.repo.addEvent({
      ticketId,
      kind: 'workorder',
      author,
      body: `Perbaikan selesai — WO ${woCode}`,
    });

    const nextStatus = this.downgradeIfBreached(ticket, 'resolved');
    await this.repo.update(ticketId, { status: nextStatus });
    await this.repo.addEvent({
      ticketId,
      kind: 'status',
      author,
      body: `Status → ${nextStatus}`,
    });
  }

  async listEvents(id: string): Promise<{ items: TicketEventResponse[]; total: number }> {
    const { items, total } = await this.repo.listEvents(id);
    return { items: items.map(toTicketEventResponse), total };
  }

  // The single source of truth for the resolve-vs-breach rule: resolving a
  // ticket after its SLA deadline records it as `breached`, not `resolved`.
  // Shared by `update()` and `resolveFromWorkOrder()` so the rule never
  // drifts between the two call sites.
  private downgradeIfBreached(ticket: Ticket, status: Ticket['status']): Ticket['status'] {
    return status === 'resolved' && ticket.slaDueAt.getTime() < Date.now() ? 'breached' : status;
  }
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

function toTicketResponse(row: Ticket): TicketResponse {
  return {
    id: row.id,
    code: row.code,
    subject: row.subject,
    customerId: row.customerId,
    customerName: row.customerName,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    slaDueAt: row.slaDueAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toTicketEventResponse(row: TicketEvent): TicketEventResponse {
  return {
    id: row.id,
    ticketId: row.ticketId,
    kind: row.kind,
    author: row.author,
    body: row.body,
    at: row.at.toISOString(),
  };
}
