import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../decorators/current-user.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Coarse-grained role gate. Returns `true` for handlers without a
 * `@Roles()` marker so the guard is safe to register globally — only
 * routes that opt in via the decorator are checked.
 *
 * Runs after JwtAuthGuard, so `req.user` is always present here. If a
 * future handler is `@Public` AND `@Roles(...)`, the public escape
 * wins (no JWT, no req.user) — flag in code review, do not split into
 * two contradictory decorators.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AuthUser['role'][]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
