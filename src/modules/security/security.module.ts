import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';

@Module({
  controllers: [SecurityController],
  providers: [SecurityService, SecurityRepository],
  // AuthModule imports this to reach `verifyLoginChallenge` during login —
  // cross-module access goes through this exported provider, never a
  // direct import of `security.service` from outside this folder.
  exports: [SecurityService],
})
export class SecurityModule {}
