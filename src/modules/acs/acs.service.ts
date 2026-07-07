import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AcsDevice, NewAcsDevice } from '../../infrastructure/database/schema/acs.schema';
import { type AcsListFilter, AcsRepository } from './acs.repository';
import type {
  AcsDeviceListResponse,
  AcsDeviceResponse,
  BulkAcsResult,
} from './dto/acs-response.dto';
import type { BulkAcsInput } from './dto/bulk-acs.dto';
import { SetWifiSchema } from './dto/set-wifi.dto';
import type { SetWifiResult, WifiResponse } from './dto/wifi-response.dto';

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

  async list(filter: AcsListFilter): Promise<AcsDeviceListResponse> {
    await this.repo.ensureSeeded(DEFAULTS);
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toAcsResponse), total, summary };
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

  /** The portal customer's own CPE WiFi identity (P3.C.4 self-care seam). */
  async wifiForCustomer(customerName: string): Promise<WifiResponse> {
    const device = await this.findDeviceForCustomer(customerName);
    return toWifiResponse(device);
  }

  /**
   * Change the portal customer's own WiFi SSID/password. `password` is
   * validated (same ssid<=32/password 8-63 constraints as the staff bulk
   * action) but never persisted — a real TR-069 ACS pushes it to the CPE
   * over CWMP; this mock only stores the SSID so the change is testable
   * end-to-end without holding a plaintext WiFi password at rest.
   */
  async setWifiForCustomer(
    customerName: string,
    ssid: string,
    password: string,
  ): Promise<SetWifiResult> {
    const parsed = SetWifiSchema.parse({ ssid, password });
    const device = await this.findDeviceForCustomer(customerName);
    const updated = await this.repo.setWifi(device.id, parsed.ssid);
    if (!updated) throw new NotFoundException('perangkat CPE tidak ditemukan untuk pelanggan ini');
    this.logger.log({ customerName, deviceId: device.id }, 'acs wifi ssid updated');
    return { ok: true, ssid: parsed.ssid };
  }

  // acs_devices is keyed by denormalized customerName only (no customer_id
  // FK — see the schema header comment). Resolving "my device" by an exact
  // match against the portal customer's fullName is consistent with the
  // existing mock ACS contract (list/bulk read the same denormalized
  // field). A real FK from acs_devices to customers is deferred hardening —
  // flagged for follow-up, not done here since it would also require a
  // migration + backfill decision.
  private async findDeviceForCustomer(customerName: string): Promise<AcsDevice> {
    await this.repo.ensureSeeded(DEFAULTS);
    const device = await this.repo.findByCustomerName(customerName);
    if (!device) throw new NotFoundException('perangkat CPE tidak ditemukan untuk pelanggan ini');
    return device;
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

function toWifiResponse(row: AcsDevice): WifiResponse {
  return { serial: row.serial, model: row.model, ssid: row.ssid };
}
