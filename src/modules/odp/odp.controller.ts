import { Controller, Get } from '@nestjs/common';
import { OdpService } from './odp.service';

// Read-only ODP capacity dashboard (any authenticated user).
@Controller({ path: 'odp', version: '1' })
export class OdpController {
  constructor(private readonly odp: OdpService) {}

  @Get()
  list() {
    return this.odp.list();
  }
}
