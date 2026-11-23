import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Always answers 404 so a disabled route looks like an unknown one: the
 * message mirrors Nest's own "Cannot METHOD /url" for an unmatched route.
 * Applied via `@MvpDisabled()`; global guards (JWT, roles) run first.
 */
@Injectable()
export class MvpDisabledGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    throw new NotFoundException(`Cannot ${req.method} ${req.url}`);
  }
}
