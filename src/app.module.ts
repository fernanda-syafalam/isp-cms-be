import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root. Should only import other modules — no controllers
 * or providers of its own. See v2 Best Practices doc, Pilar 1.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
