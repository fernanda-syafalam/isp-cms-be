import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'staff' | 'customer' | 'teknisi' | 'mitra';
  // The mitra principal's scope anchor (ADR-0010); null for other roles.
  resellerId: string | null;
  // The session id (JWT `sid` claim, SEC-2) this access token was minted
  // for — lets SecurityService mark "this is the request's own session"
  // and exclude it from "revoke other sessions" / F3. Undefined for an
  // access token minted before the claim existed (old token, still valid
  // until its own TTL) or for a caller with no session concept at all —
  // callers MUST treat `undefined` as "unknown, not necessarily current",
  // never crash on its absence.
  sessionId?: string;
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
