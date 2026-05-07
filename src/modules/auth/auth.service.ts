import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { UsersRepository } from '../users/users.repository';

interface JwtPayload {
  sub: string;
  role: AuthUser['role'];
}

export interface LoginResult {
  accessToken: string;
  user: AuthUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
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

    const payload: JwtPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
