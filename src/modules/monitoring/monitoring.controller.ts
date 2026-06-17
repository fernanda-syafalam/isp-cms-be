import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TicketResponseDto } from '../tickets/dto/ticket-response.dto';
import { MonitoringService } from './monitoring.service';

// Sort keys the FE is allowed to use for the metrics table.
// Unknown/absent key falls back to `name asc` — never throws (enforced in the repo).
const METRIC_SORT_KEYS = ['name', 'status', 'uptimePct', 'latencyMs', 'utilizationPct'] as const;

const MetricsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.enum(METRIC_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AlertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'monitoring', version: '1' })
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('metrics')
  listMetrics(@Query() query: unknown) {
    return this.monitoring.listMetrics(MetricsQuerySchema.parse(query));
  }

  @Get('alerts')
  listAlerts(@Query() query: unknown) {
    return this.monitoring.listAlerts(AlertsQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('monitoring.acknowledge')
  @Post('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.NO_CONTENT)
  acknowledge(@Param('id') id: string): Promise<void> {
    return this.monitoring.acknowledge(id);
  }

  // Escalate an alert to a high-priority NOC ticket.
  @Roles('admin', 'staff')
  @Audit('monitoring.ticket')
  @Post('alerts/:id/ticket')
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(TicketResponseDto)
  createTicket(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.monitoring.createTicket(id, user.fullName);
  }
}
