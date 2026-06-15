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
} from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Audit } from '../../common/decorators/audit.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateSecretDto, SecretResponseDto, UpdateSecretDto } from './dto/secret.dto';
import { SecretsService } from './secrets.service';

@Controller({ path: 'routers/:routerId/secrets', version: '1' })
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  list(@Param('routerId') routerId: string) {
    return this.secrets.list(routerId);
  }

  @Roles('admin', 'staff')
  @Audit('router.secret_create')
  @Post()
  @ZodSerializerDto(SecretResponseDto)
  create(@Param('routerId') routerId: string, @Body() body: CreateSecretDto) {
    return this.secrets.create(routerId, body);
  }

  @Roles('admin', 'staff')
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
