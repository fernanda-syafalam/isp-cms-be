import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  /**
   * Exchange a still-valid refresh token for a fresh access + refresh
   * pair. The previous refresh token is rotated (single-use) — a stolen
   * token has at most one replay window before the next legitimate
   * refresh invalidates it.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshTokenDto) {
    return this.auth.refresh(body.refreshToken);
  }

  /**
   * Best-effort logout — drops the supplied refresh token from the
   * server-side store. The access token is JWT and remains valid
   * until its own TTL; clients should also forget it locally.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: RefreshTokenDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  /**
   * Lightweight identity probe — confirms the bearer token resolves to
   * a known user. Useful as a smoke test for clients and as a working
   * example of the `@CurrentUser` decorator.
   */
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
