import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { UsageService } from './usage.service';

// Sort keys the FE is allowed to use for the usage table.
// Unknown/absent key falls back to `customerName asc` — never throws (enforced in the service).
const USAGE_SORT_KEYS = ['customerName', 'quotaGb', 'usedGb'] as const;

const UsageQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.enum(USAGE_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Read-only global data-usage list (any authenticated user).
@Controller({ path: 'usage', version: '1' })
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.usage.list(UsageQuerySchema.parse(query));
  }
}
