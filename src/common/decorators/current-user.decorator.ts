import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'staff' | 'customer' | 'teknisi' | 'mitra';
}

/**
 * Pulls the AuthUser that JwtStrategy.validate placed on the request.
 * `req.user` is set by Passport during the JwtAuthGuard pass.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user: AuthUser }>();
    return req.user;
  },
);
