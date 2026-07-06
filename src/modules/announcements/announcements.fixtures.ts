import type { NewAnnouncement } from '../../infrastructure/database/schema/announcements.schema';

// Deterministic uuid so re-seeding is a no-op (onConflictDoNothing on id).
const aid = (n: number) => `00000000-a000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A couple of seed rows (one info, one outage) so the portal feed and the
 * staff admin list are never empty on a fresh environment (mock-first,
 * ADR-0003). Both are open-ended (no startsAt/endsAt), so `listActive`
 * always returns them while `active` stays true.
 */
export function buildAnnouncementFixture(): NewAnnouncement[] {
  return [
    {
      id: aid(1),
      title: 'Pemeliharaan jaringan terjadwal',
      body: 'Akan ada pemeliharaan rutin pada Sabtu malam pukul 00.00–02.00. Layanan dapat terputus sesaat selama proses berlangsung.',
      severity: 'info',
      active: true,
      startsAt: null,
      endsAt: null,
    },
    {
      id: aid(2),
      title: 'Gangguan jaringan di area Jepara Kota',
      body: 'Tim teknisi kami sedang menangani gangguan fiber optik di area Jepara Kota. Mohon maaf atas ketidaknyamanannya.',
      severity: 'outage',
      active: true,
      startsAt: null,
      endsAt: null,
    },
  ];
}
