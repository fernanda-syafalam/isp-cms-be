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
import { CreateProfileDto, ProfileResponseDto, UpdateProfileDto } from './dto/profile.dto';
import { ProfilesService } from './profiles.service';

@Controller({ path: 'routers/:routerId/profiles', version: '1' })
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  list(@Param('routerId') routerId: string) {
    return this.profiles.list(routerId);
  }

  @Roles('admin', 'staff')
  @Audit('router.profile_create')
  @Post()
  @ZodSerializerDto(ProfileResponseDto)
  create(@Param('routerId') routerId: string, @Body() body: CreateProfileDto) {
    return this.profiles.create(routerId, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.profile_update')
  @Patch(':pid')
  @ZodSerializerDto(ProfileResponseDto)
  update(
    @Param('routerId') routerId: string,
    @Param('pid') pid: string,
    @Body() body: UpdateProfileDto,
  ) {
    return this.profiles.update(routerId, pid, body);
  }

  @Roles('admin', 'staff')
  @Audit('router.profile_delete')
  @Delete(':pid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('routerId') routerId: string, @Param('pid') pid: string): Promise<void> {
    return this.profiles.remove(routerId, pid);
  }
}
