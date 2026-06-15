import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Ticket, TicketEvent } from '../../infrastructure/database/schema/tickets.schema';
import { CustomersRepository } from '../customers/customers.repository';
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
      nextStatus =
        input.status === 'resolved' && ticket.slaDueAt.getTime() < Date.now()
          ? 'breached'
          : input.status;
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

  async listEvents(id: string): Promise<{ items: TicketEventResponse[]; total: number }> {
    const { items, total } = await this.repo.listEvents(id);
    return { items: items.map(toTicketEventResponse), total };
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
