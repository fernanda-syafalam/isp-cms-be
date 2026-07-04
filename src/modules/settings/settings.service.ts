import { Injectable, Logger } from '@nestjs/common';
import type {
  AppSettings,
  NewAppSettings,
} from '../../infrastructure/database/schema/settings.schema';
import type { SettingsResponse } from './dto/settings-response.dto';
import type { UpdateSettingsInput } from './dto/update-settings.dto';
import { SettingsRepository } from './settings.repository';

// Resolved billing/tax policy consumed by the invoices + billing-automation
// services (P2.3). Not an HTTP DTO — an internal read model.
export type BillingPolicy = {
  pkp: boolean;
  ppnRate: number;
  dueDays: number;
  lateFeeIdr: number;
  isolirGraceDays: number;
};

// Seeded on first read; thereafter the stored row wins.
const DEFAULTS: NewAppSettings = {
  companyName: 'Jepara Net',
  companyAddress: 'Jl. Pemuda No. 12, Jepara, Jawa Tengah',
  companyPhone: '0291-591234',
  companyEmail: 'billing@jeparanet.id',
  billingLateFeeIdr: 25_000,
  billingDueDays: 10,
  billingIsolirGraceDays: 3,
  taxPkp: true,
  taxNpwp: '01.234.567.8-901.000',
  taxPpnRate: 0.11,
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly repo: SettingsRepository) {}

  async get(): Promise<SettingsResponse> {
    return toSettingsResponse(await this.repo.getOrCreate(DEFAULTS));
  }

  /**
   * The billing/tax policy the automation reads at run time (P2.3). Backed
   * by the same singleton row as get(), so an admin edit in Settings changes
   * the next billing run, isolir sweep, and invoice — the values are no
   * longer hardcoded in the invoices/billing services.
   */
  async getBillingPolicy(): Promise<BillingPolicy> {
    const row = await this.repo.getOrCreate(DEFAULTS);
    return {
      pkp: row.taxPkp,
      ppnRate: row.taxPpnRate,
      dueDays: row.billingDueDays,
      lateFeeIdr: row.billingLateFeeIdr,
      isolirGraceDays: row.billingIsolirGraceDays,
    };
  }

  /** Merge the provided sections into the singleton row. */
  async update(input: UpdateSettingsInput): Promise<SettingsResponse> {
    await this.repo.getOrCreate(DEFAULTS); // ensure the row exists first
    const patch: Partial<NewAppSettings> = {};
    if (input.company) {
      patch.companyName = input.company.name;
      patch.companyAddress = input.company.address;
      patch.companyPhone = input.company.phone;
      patch.companyEmail = input.company.email;
    }
    if (input.billing) {
      patch.billingLateFeeIdr = input.billing.lateFeeIdr;
      patch.billingDueDays = input.billing.dueDays;
      patch.billingIsolirGraceDays = input.billing.isolirGraceDays;
    }
    if (input.tax) {
      patch.taxPkp = input.tax.pkp;
      patch.taxNpwp = input.tax.npwp;
      patch.taxPpnRate = input.tax.ppnRate;
    }
    const row = await this.repo.update(patch);
    this.logger.log('settings updated');
    return toSettingsResponse(row);
  }
}

function toSettingsResponse(row: AppSettings): SettingsResponse {
  return {
    company: {
      name: row.companyName,
      address: row.companyAddress,
      phone: row.companyPhone,
      email: row.companyEmail,
    },
    billing: {
      lateFeeIdr: row.billingLateFeeIdr,
      dueDays: row.billingDueDays,
      isolirGraceDays: row.billingIsolirGraceDays,
    },
    tax: {
      pkp: row.taxPkp,
      npwp: row.taxNpwp,
      ppnRate: row.taxPpnRate,
    },
  };
}
