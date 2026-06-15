import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionsService } from './sessions.service';

@Controller({ path: 'routers/:routerId/sessions', version: '1' })
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Param('routerId') routerId: string) {
    return this.sessions.list(routerId);
  }

  @Roles('admin', 'staff')
  @Audit('router.session_disconnect')
  @Post(':sid/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@Param('routerId') routerId: string): Promise<void> {
    return this.sessions.disconnect(routerId);
  }
}
