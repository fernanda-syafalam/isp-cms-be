import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Device, NewDevice } from '../../infrastructure/database/schema/devices.schema';
import { type DeviceListFilter, type DevicePatch, DevicesRepository } from './devices.repository';
import type { DeviceResponse } from './dto/device-response.dto';
import type { UpdateDeviceInput } from './dto/update-device.dto';

// Representative managed fleet, seeded on first read (name is unique so the
// insert is idempotent). A real backend hydrates this from GenieACS / SNMP.
const DEFAULTS: NewDevice[] = [
  {
    name: 'OLT-Jepara-1',
    type: 'olt',
    ipAddress: '10.10.0.1',
    status: 'online',
    uptimeHours: 8_760,
    rxPower: null,
    areaName: 'Jepara',
    topologyNodeId: 'olt-1',
  },
  {
    name: 'OLT-Tahunan-1',
    type: 'olt',
    ipAddress: '10.10.0.2',
    status: 'online',
    uptimeHours: 4_320,
    rxPower: null,
    areaName: 'Tahunan',
    topologyNodeId: 'olt-2',
  },
  {
    name: 'MikroTik-Core-1',
    type: 'mikrotik',
    ipAddress: '10.0.0.1',
    status: 'online',
    uptimeHours: 12_000,
    rxPower: null,
    areaName: 'Jepara',
    topologyNodeId: null,
  },
  {
    name: 'MikroTik-Edge-Pecangaan',
    type: 'mikrotik',
    ipAddress: '10.0.0.2',
    status: 'degraded',
    uptimeHours: 720,
    rxPower: null,
    areaName: 'Pecangaan',
    topologyNodeId: null,
  },
  {
    name: 'ONU-0001',
    type: 'onu',
    ipAddress: '100.64.100.2',
    status: 'online',
    uptimeHours: 2_160,
    rxPower: -18.5,
    areaName: 'Jepara',
    topologyNodeId: null,
  },
  {
    name: 'ONU-0002',
    type: 'onu',
    ipAddress: '100.64.101.2',
    status: 'online',
    uptimeHours: 1_440,
    rxPower: -21,
    areaName: 'Tahunan',
    topologyNodeId: null,
  },
  {
    name: 'ONU-0003',
    type: 'onu',
    ipAddress: '100.64.102.2',
    status: 'degraded',
    uptimeHours: 96,
    rxPower: -25.5,
    areaName: 'Pecangaan',
    topologyNodeId: null,
  },
  {
    name: 'ONU-0004',
    type: 'onu',
    ipAddress: '100.64.103.2',
    status: 'offline',
    uptimeHours: 0,
    rxPower: null,
    areaName: 'Mlonggo',
    topologyNodeId: null,
  },
];

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly repo: DevicesRepository) {}

  async list(filter: DeviceListFilter): Promise<{ items: DeviceResponse[]; total: number }> {
    await this.repo.ensureSeeded(DEFAULTS);
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toDeviceResponse), total };
  }

  async findById(id: string): Promise<DeviceResponse> {
    return toDeviceResponse(await this.requireById(id));
  }

  /** Reboot the device (no real CPE yet) — refreshes its last-seen time. */
  async reboot(id: string): Promise<DeviceResponse> {
    await this.requireById(id);
    const device = await this.repo.touchLastSeen(id);
    this.logger.log({ deviceId: id }, 'device reboot');
    return toDeviceResponse(device);
  }

  async update(id: string, input: UpdateDeviceInput): Promise<DeviceResponse> {
    const patch: DevicePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.ipAddress !== undefined) patch.ipAddress = input.ipAddress;
    if (input.areaName !== undefined) patch.areaName = input.areaName;
    return toDeviceResponse(await this.repo.update(id, patch));
  }

  async remove(id: string): Promise<void> {
    await this.repo.remove(id);
    this.logger.log({ deviceId: id }, 'device decommissioned');
  }

  private async requireById(id: string): Promise<Device> {
    const device = await this.repo.findById(id);
    if (!device) throw new NotFoundException('device not found');
    return device;
  }
}

function toDeviceResponse(row: Device): DeviceResponse {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ipAddress: row.ipAddress,
    status: row.status,
    uptimeHours: row.uptimeHours,
    rxPower: row.rxPower,
    areaName: row.areaName,
    lastSeenAt: row.lastSeenAt.toISOString(),
    topologyNodeId: row.topologyNodeId,
  };
}
