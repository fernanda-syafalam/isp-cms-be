import { Injectable } from '@nestjs/common';
import type {
  AuditLogEntry,
  NewAuditLogEntry,
} from '../../infrastructure/database/schema/audit.schema';
import { type AuditListFilter, AuditRepository } from './audit.repository';
import type { AuditEntryResponse, AuditListResponse } from './dto/audit-response.dto';

// A shared customer id so the per-record (entityId) filter has something to
// return — two entries below reference the same subscriber.
const CUST_ID = 'cust-1001';

// Representative trail seeded on first read (fixed ids → idempotent insert).
// `entity`/`summary` are user-facing, so they are in Bahasa; `action` stays a
// machine verb-phrase (English) matching the runtime @Audit() convention.
const DEFAULTS: NewAuditLogEntry[] = [
  {
    id: '00000000-0000-0000-0000-00000000a001',
    at: new Date('2026-06-15T01:05:00.000Z'),
    actor: 'admin@ashnet.id',
    action: 'billing.run',
    entity: 'Tagihan',
    summary: 'Menjalankan penagihan massal untuk 312 pelanggan',
  },
  {
    id: '00000000-0000-0000-0000-00000000a002',
    at: new Date('2026-06-15T02:30:00.000Z'),
    actor: 'staff@ashnet.id',
    action: 'customer.suspend',
    entity: 'Pelanggan',
    summary: 'Mengisolir pelanggan karena tunggakan',
    entityId: CUST_ID,
  },
  {
    id: '00000000-0000-0000-0000-00000000a003',
    at: new Date('2026-06-15T04:10:00.000Z'),
    actor: 'staff@ashnet.id',
    action: 'payment.confirm',
    entity: 'Pembayaran',
    summary: 'Mengonfirmasi pembayaran tagihan INV-2026-0312',
  },
  {
    id: '00000000-0000-0000-0000-00000000a004',
    at: new Date('2026-06-15T05:45:00.000Z'),
    actor: 'admin@ashnet.id',
    action: 'customer.activate',
    entity: 'Pelanggan',
    summary: 'Mengaktifkan kembali pelanggan setelah pelunasan',
    entityId: CUST_ID,
  },
  {
    id: '00000000-0000-0000-0000-00000000a005',
    at: new Date('2026-06-15T07:20:00.000Z'),
    actor: 'noc@ashnet.id',
    action: 'ticket.resolve',
    entity: 'Tiket',
    summary: 'Menutup tiket gangguan koneksi area Pecangaan',
  },
  {
    id: '00000000-0000-0000-0000-00000000a006',
    at: new Date('2026-06-15T09:00:00.000Z'),
    actor: 'admin@ashnet.id',
    action: 'plan.update',
    entity: 'Paket Layanan',
    summary: 'Mengubah harga paket Home 50 Mbps',
  },
  {
    id: '00000000-0000-0000-0000-00000000a007',
    at: new Date('2026-06-15T11:15:00.000Z'),
    actor: 'staff@ashnet.id',
    action: 'device.reboot',
    entity: 'Perangkat',
    summary: 'Reboot ONU pelanggan area Tahunan',
  },
  {
    id: '00000000-0000-0000-0000-00000000a008',
    at: new Date('2026-06-15T13:40:00.000Z'),
    actor: 'admin@ashnet.id',
    action: 'user.create',
    entity: 'Pengguna',
    summary: 'Menambahkan akun staf baru untuk tim billing',
  },
];

@Injectable()
export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  async list(filter: AuditListFilter): Promise<AuditListResponse> {
    await this.repo.ensureSeeded(DEFAULTS);
    const { items, total } = await this.repo.list(filter);
    return { items: items.map(toAuditResponse), total };
  }
}

function toAuditResponse(row: AuditLogEntry): AuditEntryResponse {
  return {
    id: row.id,
    at: row.at.toISOString(),
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    summary: row.summary,
    // `entityId` is optional on the wire — omit it (never send null) so the
    // FE's `.optional()` schema accepts the payload.
    ...(row.entityId ? { entityId: row.entityId } : {}),
  };
}
