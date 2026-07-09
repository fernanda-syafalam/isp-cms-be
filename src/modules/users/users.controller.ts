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
import { UserListResponseDto, UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Strip sensitive columns and normalize the Drizzle `Date` column to the
 * ISO string `UserResponseSchema` (`createdAt: z.iso.datetime()`)
 * declares. The global `ZodSerializerInterceptor` parses the return
 * value against that schema, and a raw `Date` fails `z.iso.datetime()`
 * (a *string* schema) — so every handler that returns a user must go
 * through this, like `list` already does for the field-stripping half.
 */
function toUserResponse<
  T extends { passwordHash: string; deletedAt: Date | null; createdAt: Date },
>(user: T) {
  const { passwordHash: _passwordHash, deletedAt: _deletedAt, createdAt, ...rest } = user;
  return { ...rest, createdAt: createdAt.toISOString() };
}

@Roles('admin', 'staff')
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
  @ZodSerializerDto(UserListResponseDto)
  async list(@Query() query: unknown) {
    // Coerced via zod — global ZodValidationPipe doesn't validate
    // plain query objects, so we parse here. The first business
    // module that wants this pattern should likely move the cursor
    // schema into a shared `common/pagination/` once a second module
    // needs it (rule of three).
    const { cursor, limit } = CursorQuerySchema.parse(query);
    const page = await this.users.list(cursor, limit);
    // `toUserResponse` both strips (passwordHash/deletedAt) and ISO-converts
    // `createdAt` — required now that `@ZodSerializerDto` validates against
    // `UserListResponseSchema` (`createdAt: z.iso.datetime()`, a *string*
    // schema) before the response is sent; a raw Date would fail that parse.
    return {
      items: page.items.map(toUserResponse),
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

  // Admin-issued credential reset (P1.4). The fresh one-time password is
  // returned exactly once for handoff; a set-password link replaces this
  // once P2 notifications exist.
  @Roles('admin')
  @Audit('user.reset_password')
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Param('id') id: string): Promise<{ initialPassword: string }> {
    return this.users.resetPassword(id);
  }
}
