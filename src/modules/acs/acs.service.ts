import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { AcsDevice, NewAcsDevice } from '../../infrastructure/database/schema/acs.schema';
import { type AcsListFilter, AcsRepository } from './acs.repository';
import type { AcsDeviceResponse, BulkAcsResult } from './dto/acs-response.dto';
import type { BulkAcsInput } from './dto/bulk-acs.dto';

// Seeded CPE inventory until a real ACS (GenieACS) feeds the table.
const DEFAULTS: NewAcsDevice[] = [
  {
    serial: 'ZTEG10000001',
    customerName: 'Budi Santoso',
    model: 'ZTE F670L',
    firmware: 'v2.3.0',
    rxPowerDbm: -21.5,
    status: 'online',
  },
  {
    serial: 'ZTEG10000002',
    customerName: 'Ani Pertiwi',
    model: 'Huawei HG8145',
    firmware: 'v2.2.8',
    rxPowerDbm: -24,
    status: 'online',
  },
  {
    serial: 'ZTEG10000003',
    customerName: 'Citra Lestari',
    model: 'ZTE F670L',
    firmware: 'v2.3.0',
    rxPowerDbm: null,
    status: 'offline',
  },
];

@Injectable()
export class AcsService {
  private readonly logger = new Logger(AcsService.name);

  constructor(private readonly repo: AcsRepository) {}

  async list(filter: AcsListFilter): Promise<{ items: AcsDeviceResponse[]; total: number }> {
    await this.repo.ensureSeeded(DEFAULTS);
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toAcsResponse), total };
  }

  /**
   * Run a bulk CPE action. firmware persists the new version; reboot and
   * wifi are acknowledgments (no stored state — RouterOS/GenieACS owns the
   * live device). Returns how many devices were affected.
   */
  async bulk(input: BulkAcsInput): Promise<BulkAcsResult> {
    let affected: number;
    if (input.action === 'firmware') {
      if (!input.firmwareVersion) {
        throw new BadRequestException('firmwareVersion is required for a firmware action');
      }
      affected = await this.repo.updateFirmware(input.deviceIds, input.firmwareVersion);
    } else if (input.action === 'wifi') {
      if (!input.ssid || !input.password) {
        throw new BadRequestException('ssid and password are required for a wifi action');
      }
      affected = await this.repo.countByIds(input.deviceIds);
    } else {
      affected = await this.repo.countByIds(input.deviceIds);
    }
    this.logger.log({ action: input.action, affected }, 'acs bulk action');
    return { affected };
  }
}

function toAcsResponse(row: AcsDevice): AcsDeviceResponse {
  return {
    id: row.id,
    serial: row.serial,
    customerName: row.customerName,
    model: row.model,
    firmware: row.firmware,
    rxPowerDbm: row.rxPowerDbm,
    status: row.status,
    lastInform: row.lastInform.toISOString(),
  };
}
