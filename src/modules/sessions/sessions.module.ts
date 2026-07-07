import { Module } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';

/**
 * Owns the opaque refresh-token store AND the per-user session registry
 * (SEC-2) it is keyed alongside — both are Redis-backed and live in
 * lockstep (same TTL, same lifecycle), so they are one cohesive service
 * rather than two collaborating ones.
 *
 * A dedicated leaf module (no imports of its own) so both `AuthModule`
 * (mint/rotate/revoke on login/refresh/logout) and `SecurityModule`
 * (list/revoke for the security page, F3 on 2FA enable) can import it
 * without a cycle — `AuthModule` already imports `SecurityModule` for
 * `verifyLoginChallenge`, so `SecurityModule` cannot import `AuthModule`
 * back.
 */
@Module({
  providers: [RefreshTokenService],
  exports: [RefreshTokenService],
})
export class SessionsModule {}
