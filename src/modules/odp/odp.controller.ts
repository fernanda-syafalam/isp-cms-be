import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { OdpService } from './odp.service';

// Sort keys the FE is allowed to use for the ODP list.
// Unknown/absent key falls back to `name asc` — never throws (enforced in the repo).
const ODP_SORT_KEYS = ['name', 'usedPorts', 'avgRxPowerDbm'] as const;

const OdpQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  sort: z.enum(ODP_SORT_KEYS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  view: z.enum(['available', 'full', 'optical']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
// Read-only ODP capacity dashboard (staff surface, P0.2).
@Roles('admin', 'staff')
@Controller({ path: 'odp', version: '1' })
export class OdpController {
  constructor(private readonly odp: OdpService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.odp.list(OdpQuerySchema.parse(query));
  }
}
