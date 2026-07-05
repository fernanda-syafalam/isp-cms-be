import { Controller, Get } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { SetupStatusDto } from './dto/setup-status-response.dto';
import { SetupService } from './setup.service';

/**
 * First-run setup checklist for the operator. Admin-only — it exposes
 * whether staff accounts and company settings are configured, which is not
 * something other roles need to see.
 */
@Controller({ path: 'setup', version: '1' })
@Roles('admin')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  @ZodSerializerDto(SetupStatusDto)
  getStatus() {
    return this.setup.getStatus();
  }
}
