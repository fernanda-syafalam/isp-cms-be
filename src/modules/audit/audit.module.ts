import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

// Global so the app-wide AuditInterceptor (APP_INTERCEPTOR) can inject
// AuditRepository to persist audited actions without per-module imports.
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRepository],
  exports: [AuditRepository],
})
export class AuditModule {}
