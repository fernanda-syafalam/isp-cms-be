import { Module } from '@nestjs/common';
import { RouterCredentialCipherService } from './router-credential-cipher.service';
import { RoutersController } from './routers.controller';
import { RoutersRepository } from './routers.repository';
import { RoutersService } from './routers.service';

@Module({
  controllers: [RoutersController],
  providers: [RoutersService, RoutersRepository, RouterCredentialCipherService],
  // Exported so the PPPoE-secrets module (next) can maintain secretCount, and
  // so RouterResourcesModule's live RouterOS adapter can decrypt a target
  // router's per-router credential (SEC-M1) without a direct cross-module
  // file import — it imports RoutersModule and gets this exported provider.
  exports: [RoutersService, RoutersRepository, RouterCredentialCipherService],
})
export class RoutersModule {}
