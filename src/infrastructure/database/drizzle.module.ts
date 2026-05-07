import { Global, Module } from '@nestjs/common';
import { DrizzleService } from './drizzle.service';

/**
 * Global because almost every domain module needs database access via
 * its repository. Per Pilar 1 the @Global() escape hatch is reserved
 * for infrastructure modules — never for business modules.
 */
@Global()
@Module({
  providers: [DrizzleService],
  exports: [DrizzleService],
})
export class DrizzleModule {}
