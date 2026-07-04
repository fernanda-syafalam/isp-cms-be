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
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Strip sensitive columns before a user row leaves the API. The
 * ZodSerializerDto annotations are NOT enforced at runtime (no global
 * ZodSerializerInterceptor is registered — tracked as a follow-up), so
 * every handler that returns a user must strip explicitly, like `list`
 * always has.
 */
function toUserResponse<T extends { passwordHash: string; deletedAt: Date | null }>(user: T) {
  const { passwordHash: _passwordHash, deletedAt: _deletedAt, ...rest } = user;
  return rest;
}

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Creating an account is privileged: the payload carries `role`
  // (including `admin`), so a public endpoint would let anyone mint an
  // admin. Staff accounts are provisioned by an admin; customer logins
  // arrive via onboarding (P1), never self-signup.
  @Roles('admin')
  @Audit('user.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(UserResponseDto)
  async create(@Body() body: CreateUserDto) {
    return toUserResponse(await this.users.create(body));
  }

  @Get(':id')
  @ZodSerializerDto(UserResponseDto)
  async findOne(@Param('id') id: string) {
    return toUserResponse(await this.users.findById(id));
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
  async update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return toUserResponse(await this.users.update(id, body));
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
