import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CoverageService } from './coverage.service';
import { Roles } from '../../common/decorators/roles.decorator';

const ListQuerySchema = z.object({
  status: z.enum(['operational', 'maintenance', 'down']).optional(),
  type: z.enum(['pop', 'area']).optional(),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
// Read-only coverage map (staff surface, P0.2).
@Roles('admin', 'staff')
@Controller({ path: 'coverage', version: '1' })
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.coverage.list(ListQuerySchema.parse(query));
  }
}
