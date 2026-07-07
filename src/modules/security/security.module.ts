import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { SecurityController } from './security.controller';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';
import { TotpLockoutService } from './totp-lockout.service';

@Module({
  // SessionsModule (not AuthModule — that would cycle back, since
  // AuthModule imports this module for `verifyLoginChallenge`) provides
  // `RefreshTokenService`, the real backing store for the session list +
  // revoke endpoints (SEC-2).
  imports: [SessionsModule],
  controllers: [SecurityController],
  providers: [SecurityService, SecurityRepository, TotpLockoutService],
  // AuthModule imports this to reach `verifyLoginChallenge` during login —
  // cross-module access goes through this exported provider, never a
  // direct import of `security.service` from outside this folder.
  exports: [SecurityService],
})
export class SecurityModule {}
