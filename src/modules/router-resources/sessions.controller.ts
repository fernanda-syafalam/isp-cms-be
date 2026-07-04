import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionListResponseDto } from './dto/session.dto';
import { SessionsService } from './sessions.service';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Controller({ path: 'routers/:routerId/sessions', version: '1' })
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  @ZodSerializerDto(SessionListResponseDto)
  list(@Param('routerId') routerId: string, @Query() query: unknown) {
    return this.sessions.list(routerId, ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff')
  @Audit('router.session_disconnect')
  @Post(':sid/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@Param('routerId') routerId: string): Promise<void> {
    return this.sessions.disconnect(routerId);
  }
}
