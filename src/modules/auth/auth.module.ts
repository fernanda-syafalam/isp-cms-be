import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { AppConfig } from '../../config/configuration';
import { SecurityModule } from '../security/security.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule, UsersModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ app: AppConfig }, true>) => ({
        secret: config.get('app.jwt.secret', { infer: true }),
        signOptions: {
          expiresIn: config.get('app.jwt.expiresIn', { infer: true }),
        },
      }),
    }),
    UsersModule,
    SecurityModule,
    // Refresh-token store + per-user session registry (SEC-2) — also
    // imported by SecurityModule for the security page's session list
    // and revoke endpoints. See SessionsModule's doc comment for why
    // this lives in its own leaf module instead of AuthModule.
    SessionsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
