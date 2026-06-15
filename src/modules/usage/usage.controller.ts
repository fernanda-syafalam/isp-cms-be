import { Controller, Get } from '@nestjs/common';
import { UsageService } from './usage.service';

// Read-only global data-usage list (any authenticated user).
@Controller({ path: 'usage', version: '1' })
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  list() {
    return this.usage.list();
  }
}
