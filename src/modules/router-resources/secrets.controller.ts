import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateSecretDto,
  SecretListResponseDto,
  SecretResponseDto,
  UpdateSecretDto,
} from './dto/secret.dto';
import { SecretsService } from './secrets.service';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@Roles('admin', 'staff', 'teknisi')
@Controller({ path: 'routers/:routerId/secrets', version: '1' })
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @ZodSerializerDto(SecretListResponseDto)
  list(@Param('routerId') routerId: string, @Query() query: unknown) {
    return this.secrets.list(routerId, ListQuerySchema.parse(query));
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('router.secret_create')
  @Post()
  @ZodSerializerDto(SecretResponseDto)
  create(@Param('routerId') routerId: string, @Body() body: CreateSecretDto) {
    return this.secrets.create(routerId, body);
  }

  @Roles('admin', 'staff', 'teknisi')
  @Audit('router.secret_update')
  @Patch(':sid')
  @ZodSerializerDto(SecretResponseDto)
  update(
    @Param('routerId') routerId: string,
    @Param('sid') sid: string,
    @Body() body: UpdateSecretDto,
  ) {
    return this.secrets.update(routerId, sid, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.secret_delete')
  @Delete(':sid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('routerId') routerId: string, @Param('sid') sid: string): Promise<void> {
    return this.secrets.remove(routerId, sid);
  }
}
