import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { SecurityService } from '../security/security.service';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import type { BootstrapInput } from './dto/bootstrap.dto';
import { RefreshTokenService } from './refresh-token.service';

interface JwtPayload {
  sub: string;
  role: AuthUser['role'];
}

/**
 * Internal result carrying both the access token and the raw refresh
 * token + TTL so the controller can set the httpOnly cookie. Neither
 * `refreshToken` nor `refreshExpiresInSeconds` is ever sent in the
 * JSON body — the controller extracts them before building the response.
 */
export interface LoginResult {
  accessToken: string;
  /** Raw opaque refresh token — MUST be placed in httpOnly cookie, not JSON body. */
  refreshToken: string;
  refreshExpiresInSeconds: number;
  user: AuthUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly security: SecurityService,
  ) {}

  /** True only when no user exists yet — the first-run bootstrap window. */
  async bootstrapRequired(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  /**
   * Create the first admin (empty-table only) and immediately log them in —
   * returns a LoginResult so the controller sets the refresh cookie exactly
   * like login(). Throws 409 once any user exists (single-use). Role is forced
   * to 'admin' inside UsersService; the empty-check + insert are serialized by
   * an advisory lock so concurrent bootstrap attempts cannot both succeed.
   */
  async bootstrapAdmin(input: BootstrapInput): Promise<LoginResult> {
    const user = await this.users.bootstrapAdmin(input);
    if (!user) {
      throw new ConflictException('bootstrap already completed');
    }
    const accessToken = await this.signAccess(user.id, user.role);
    const refresh = await this.refreshTokens.mint(user.id);
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  /**
   * `totpCode` is optional and only consulted once the password has
   * already checked out (Pilar: never leak "you'd need a 2FA code" to an
   * attacker guessing passwords). ADR-0002 documents the two error
   * markers this can throw: `totp_required` (2FA on, no/blank code sent —
   * client should prompt) and `totp_invalid` (2FA on, code sent but
   * wrong). No token is issued in either case.
   */
  async login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
    const user = await this.usersRepo.findByEmail(email);
    // Same response shape for "user not found" and "password mismatch"
    // so an attacker cannot enumerate registered emails through timing
    // or message differences.
    const fakeHash = '$argon2id$v=19$m=19456,t=2,p=1$placeholder$invalid';
    const passwordOk = await argon2
      .verify(user?.passwordHash ?? fakeHash, password)
      .catch(() => false);
    if (!user || !passwordOk) {
      throw new UnauthorizedException('invalid credentials');
    }

    const challenge = await this.security.verifyLoginChallenge(user.id, totpCode);
    if (challenge === 'required') {
      throw new UnauthorizedException({
        message: 'two-factor authentication code required',
        code: 'totp_required',
      });
    }
    if (challenge === 'invalid') {
      throw new UnauthorizedException({
        message: 'invalid two-factor authentication code',
        code: 'totp_invalid',
      });
    }

    const accessToken = await this.signAccess(user.id, user.role);
    const refresh = await this.refreshTokens.mint(user.id);
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  /**
   * Trade a refresh token for a fresh pair. The old refresh token is
   * single-use (rotated) so a leaked token has at most one replay
   * window before the next legitimate refresh invalidates it.
   */
  async refresh(rawRefreshToken: string): Promise<LoginResult> {
    const { userId, refresh } = await this.refreshTokens.rotate(rawRefreshToken);
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      // User got deleted between issuance and refresh; treat as logged out.
      throw new UnauthorizedException('invalid refresh token');
    }
    const accessToken = await this.signAccess(user.id, user.role);
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresInSeconds: refresh.expiresInSeconds,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        resellerId: user.resellerId,
      },
    };
  }

  async logout(rawRefreshToken: string): Promise<void> {
    await this.refreshTokens.revoke(rawRefreshToken);
  }

  private async signAccess(userId: string, role: AuthUser['role']): Promise<string> {
    const payload: JwtPayload = { sub: userId, role };
    return this.jwt.signAsync(payload);
  }
}
