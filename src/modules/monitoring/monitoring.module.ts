import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { MonitoringController } from './monitoring.controller';
import { MonitoringRepository } from './monitoring.repository';
import { MonitoringService } from './monitoring.service';

@Module({
  // TicketsModule provides TicketsService for alert -> ticket escalation.
  imports: [TicketsModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, MonitoringRepository],
  exports: [MonitoringService, MonitoringRepository],
})
export class MonitoringModule {}
