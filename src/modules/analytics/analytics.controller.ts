import { Controller, Get } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { DashboardSummaryDto } from './dto/dashboard-summary-response.dto';
import { ReportsSummaryDto } from './dto/reports-summary-response.dto';

/**
 * Operations dashboard + business reports. Internal-only (admin/staff) —
 * these rollups expose revenue, churn and receivables, so the customer role
 * is excluded (the portal has its own scoped endpoint).
 */
@Controller({ path: 'analytics', version: '1' })
@Roles('admin', 'staff')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  @ZodSerializerDto(DashboardSummaryDto)
  getDashboard() {
    return this.analytics.getDashboard();
  }

  @Get('reports')
  @ZodSerializerDto(ReportsSummaryDto)
  getReports() {
    return this.analytics.getReports();
  }
}
