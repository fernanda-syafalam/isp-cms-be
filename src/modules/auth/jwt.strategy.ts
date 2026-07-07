import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type { AppConfig } from '../../config/configuration';
import { UsersRepository } from '../users/users.repository';

interface JwtPayload {
  sub: string;
  role: AuthUser['role'];
  // SEC-2: the session id this access token was minted for. Optional —
  // an access token signed before this claim existed simply lacks it;
  // `validate` below must degrade gracefully (sessionId stays undefined)
  // rather than reject the token.
  sid?: string;
  iat: number;
  exp: number;
}

/**
 * Validates an incoming JWT and rehydrates `req.user` from Postgres.
 * Doing the lookup on every request is the simplest correct default;
 * once the service grows, consider caching the AuthUser in Redis with
 * a short TTL and explicit invalidation on role change — see v2 doc,
 * Pilar 4.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<{ app: AppConfig }, true>,
    private readonly usersRepo: UsersRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('app.jwt.secret', { infer: true }),
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.usersRepo.findById(payload.sub);
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      resellerId: user.resellerId,
      sessionId: payload.sid,
    };
  }
}
