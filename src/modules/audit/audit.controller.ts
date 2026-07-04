import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditService } from './audit.service';

const ListQuerySchema = z.object({
  entityId: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Read-only audit trail. Gated to admin/staff — the mutation history is an
 * operations concern and must not be exposed to customer-role accounts.
 */
@Roles('admin', 'staff')
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles('admin', 'staff')
  @Get()
  list(@Query() query: unknown) {
    return this.audit.list(ListQuerySchema.parse(query));
  }
}
