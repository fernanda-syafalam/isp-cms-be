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
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Self-registration is the simplest reference flow — leave it public
  // for now. In a real service this might be admin-only, behind an
  // invite token, or hidden behind a separate signup module.
  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(UserResponseDto)
  create(@Body() body: CreateUserDto) {
    return this.users.create(body);
  }

  @Get(':id')
  @ZodSerializerDto(UserResponseDto)
  findOne(@Param('id') id: string) {
    return this.users.findById(id);
  }

  @Get()
  async list(@Query() query: unknown) {
    // Coerced via zod — global ZodValidationPipe doesn't validate
    // plain query objects, so we parse here. The first business
    // module that wants this pattern should likely move the cursor
    // schema into a shared `common/pagination/` once a second module
    // needs it (rule of three).
    const { cursor, limit } = CursorQuerySchema.parse(query);
    const page = await this.users.list(cursor, limit);
    return {
      items: page.items.map(
        ({ passwordHash: _passwordHash, deletedAt: _deletedAt, ...rest }) => rest,
      ),
      nextCursor: page.nextCursor,
    };
  }

  // Edit a staff/user record (name + role). Admin-only + audited — a
  // role change is privileged. Email/password are not editable here.
  @Roles('admin')
  @Audit('user.update')
  @Patch(':id')
  @ZodSerializerDto(UserResponseDto)
  update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return this.users.update(id, body);
  }

  // Soft-delete is admin-only and audited. Demonstrates the Pilar 4
  // RBAC + audit pattern: @Roles for coarse role gating, @Audit so
  // the operation lands in the audit log stream alongside actor +
  // target + outcome.
  @Roles('admin')
  @Audit('user.soft_delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.users.softDelete(id);
  }
}
