import type { NewOdpRecord } from '../../infrastructure/database/schema/odp.schema';

// Jepara-area service areas — the ODP names embed the first 3 letters.
const AREA_NAMES = [
  'Jepara',
  'Tahunan',
  'Pecangaan',
  'Kalinyamatan',
  'Mlonggo',
  'Bangsri',
  'Mayong',
  'Batealit',
];

// Deterministic uuid-shaped id so re-seeding is a no-op (mirrors the FE fixture).
const oid = (prefix: string, n: number) =>
  `${prefix}-1111-4111-8111-${String(n).padStart(12, '0')}`;

/**
 * 12 distribution points with derived capacity + optical health. Mirrors the FE
 * ODP_FIXTURES formula exactly so the contract matches: every-3rd ODP is a 1:16
 * splitter (else 1:8); RX power walks -18..-28 dBm and maps to health bands.
 */
export function buildOdpFixture(): NewOdpRecord[] {
  return Array.from({ length: 12 }, (_, i) => {
    const is16 = i % 3 === 0;
    const totalPorts = is16 ? 16 : 8;
    const usedPorts = Math.min(totalPorts, 2 + ((i * 5) % (totalPorts + 1)));
    const rx = -18 - (i % 11); // -18 .. -28 dBm
    const status: NewOdpRecord['status'] =
      rx >= -25 ? 'healthy' : rx >= -27 ? 'warning' : 'critical';
    const area = AREA_NAMES[i % AREA_NAMES.length] ?? 'Jepara';
    return {
      id: oid('0d90d900', i),
      name: `ODP-${area.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
      area,
      splitter: is16 ? '1:16' : '1:8',
      totalPorts,
      usedPorts,
      avgRxPowerDbm: rx,
      status,
    };
  });
}
