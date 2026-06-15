import type {
  NewNetworkNode,
  NodeMeta,
} from '../../infrastructure/database/schema/topology.schema';

// A self-contained subscriber set for the topology fixture. Other mock modules
// (acs/monitoring/coverage) are self-seeding islands and do not read the real
// customers table — topology follows the same pattern: these synthetic ids are
// what `meta.customerId` / the `${id}-node` customer node id reference.
type FixtureSubscriber = {
  id: string;
  fullName: string;
  // Billing lifecycle (kept on meta.lifecycle); distinct from network status.
  status: 'aktif' | 'isolir' | 'berhenti' | 'instalasi';
  planName: string;
  phone: string;
  // Provisioning snapshot — null for not-yet-provisioned (instalasi) subscribers.
  connection: { rxPower: number | null; onuSerial: string | null; ponPort: string | null } | null;
};

const SUBSCRIBERS: FixtureSubscriber[] = [
  {
    id: 'cust-1',
    fullName: 'Budi Santoso',
    status: 'aktif',
    planName: 'Home 20',
    phone: '081234500001',
    connection: { rxPower: -21.5, onuSerial: 'ZTEG10000001', ponPort: '0/1/1' },
  },
  {
    id: 'cust-2',
    fullName: 'Ani Pertiwi',
    status: 'aktif',
    planName: 'Home 50',
    phone: '081234500002',
    connection: { rxPower: -22, onuSerial: 'ZTEG10000002', ponPort: '0/1/2' },
  },
  {
    id: 'cust-3',
    fullName: 'Citra Lestari',
    status: 'isolir',
    planName: 'Home 20',
    phone: '081234500003',
    connection: { rxPower: -24, onuSerial: 'ZTEG10000003', ponPort: '0/1/3' },
  },
  {
    id: 'cust-4',
    fullName: 'Dewi Anggraini',
    status: 'aktif',
    planName: 'Home 100',
    phone: '081234500004',
    connection: { rxPower: -19, onuSerial: 'ZTEG10000004', ponPort: '0/1/4' },
  },
  {
    id: 'cust-5',
    fullName: 'Eko Prasetyo',
    status: 'aktif',
    planName: 'Home 20',
    phone: '081234500005',
    connection: { rxPower: -23, onuSerial: 'ZTEG10000005', ponPort: '0/2/1' },
  },
  {
    id: 'cust-6',
    fullName: 'Fitri Handayani',
    status: 'isolir',
    planName: 'Home 50',
    phone: '081234500006',
    connection: { rxPower: -25, onuSerial: 'ZTEG10000006', ponPort: '0/2/2' },
  },
  {
    id: 'cust-7',
    fullName: 'Gunawan Wibowo',
    status: 'aktif',
    planName: 'Home 20',
    phone: '081234500007',
    connection: { rxPower: -20, onuSerial: 'ZTEG10000007', ponPort: '0/2/3' },
  },
  {
    id: 'cust-8',
    fullName: 'Hesti Wulandari',
    status: 'berhenti',
    planName: 'Home 20',
    phone: '081234500008',
    connection: null,
  },
  {
    id: 'cust-9',
    fullName: 'Indra Kusuma',
    status: 'aktif',
    planName: 'Home 50',
    phone: '081234500009',
    connection: { rxPower: -26, onuSerial: 'ZTEG10000009', ponPort: '0/3/1' },
  },
  {
    id: 'cust-10',
    fullName: 'Joko Susilo',
    status: 'instalasi',
    planName: 'Home 20',
    phone: '081234500010',
    connection: null,
  },
  {
    id: 'cust-11',
    fullName: 'Kartika Sari',
    status: 'aktif',
    planName: 'Home 100',
    phone: '081234500011',
    connection: { rxPower: -18, onuSerial: 'ZTEG10000011', ponPort: '0/3/2' },
  },
];

// NETWORK status (map color) is distinct from BILLING lifecycle: an isolir
// (suspended) customer is still optically `up` (fiber not cut) — so dispatch
// never mistakes "belum bayar" for "fiber putus". berhenti (disconnected) and
// instalasi (not yet provisioned) -> unknown.
const CUST_STATUS: Record<FixtureSubscriber['status'], NewNetworkNode['status']> = {
  aktif: 'up',
  isolir: 'up',
  berhenti: 'unknown',
  instalasi: 'unknown',
};

/**
 * Build the topology node forest: OLT -> ODC -> ODP -> pole -> customer, around
 * Jepara. Customer nodes carry a GLOBAL fiber core number (poleIndex*12 + core)
 * so fiberId() resolves tube + core colours; deriveCabling() reads it back. The
 * splitter/ports/portsUsed meta seeded here is overwritten by the read-time
 * projection (it is a projection of the cabling, never the source of truth).
 */
export function buildTopologyFixture(): NewNetworkNode[] {
  const nodes: NewNetworkNode[] = [];
  const poles: Array<{ id: string; lat: number; lng: number }> = [];
  const center = { lat: -6.5514, lng: 110.6811 }; // Kota Jepara, Jawa Tengah
  const STATUS_CYCLE: NewNetworkNode['status'][] = [
    'up',
    'up',
    'up',
    'up',
    'down',
    'unknown',
    'up',
    'up',
  ];
  let k = 0;

  for (let o = 0; o < 2; o++) {
    const oltId = `olt-${o + 1}`;
    const oLat = center.lat + (o - 0.5) * 0.02;
    const oLng = center.lng + (o - 0.5) * 0.03;
    nodes.push({
      id: oltId,
      name: `OLT ${o + 1}`,
      type: 'olt',
      status: 'up',
      lat: oLat,
      lng: oLng,
      parentId: null,
      meta: {
        model: 'ZTE C320',
        ipAddress: `10.20.${o + 1}.1`,
        portsUsed: 6 + o * 2,
        portsTotal: 16,
        uptimePct: 99.95,
      },
    });

    for (let c = 0; c < 2; c++) {
      const odcId = `${oltId}-odc-${c + 1}`;
      const cLat = oLat + (c - 0.5) * 0.012;
      const cLng = oLng + (c - 0.5) * 0.016 + 0.006;
      nodes.push({
        id: odcId,
        name: `ODC ${o + 1}.${c + 1}`,
        type: 'odc',
        status: STATUS_CYCLE[k++ % STATUS_CYCLE.length] ?? 'up',
        lat: cLat,
        lng: cLng,
        parentId: oltId,
        meta: {
          ipAddress: `10.20.${o + 1}.${10 + c}`,
          splitter: '1:4',
          portsUsed: 2 + c,
          portsTotal: 4,
          uptimePct: 99.9,
        },
      });

      for (let d = 0; d < 2; d++) {
        const odpId = `${odcId}-odp-${d + 1}`;
        const dLat = cLat + (d - 0.5) * 0.008;
        const dLng = cLng + (d - 0.5) * 0.01 + 0.005;
        nodes.push({
          id: odpId,
          name: `ODP ${o + 1}.${c + 1}.${d + 1}`,
          type: 'odp',
          status: STATUS_CYCLE[k++ % STATUS_CYCLE.length] ?? 'up',
          lat: dLat,
          lng: dLng,
          parentId: odcId,
          meta: {
            splitter: '1:8',
            portsUsed: 4 + ((o + c + d) % 4),
            portsTotal: 8,
            rxPowerDbm: -20 - ((o + c + d) % 6),
            uptimePct: 99.8,
          },
        });

        const poleId = `${odpId}-pole`;
        const pLat = dLat + 0.0025;
        const pLng = dLng + 0.003;
        nodes.push({
          id: poleId,
          name: `Tiang ${o + 1}.${c + 1}.${d + 1}`,
          type: 'pole',
          status: 'up',
          lat: pLat,
          lng: pLng,
          parentId: odpId,
        });
        poles.push({ id: poleId, lat: pLat, lng: pLng });
      }
    }
  }

  // Attach subscribers as customer nodes (id `${customerId}-node`). coreNo is the
  // GLOBAL fiber number (poleIndex*12 + core within the pole's tube).
  const corePerPole = new Map<string, number>();
  SUBSCRIBERS.forEach((cust, i) => {
    const poleIndex = i % poles.length;
    const pole = poles[poleIndex];
    if (!pole) return;
    const coreInTube = (corePerPole.get(pole.id) ?? 0) + 1;
    corePerPole.set(pole.id, coreInTube);
    const coreNo = poleIndex * 12 + coreInTube;
    const meta: NodeMeta = {
      customerId: cust.id,
      planName: cust.planName,
      coreNo,
      lifecycle: cust.status,
      ...(cust.connection?.rxPower != null ? { rxPowerDbm: cust.connection.rxPower } : {}),
      ...(cust.connection?.onuSerial ? { onuSerial: cust.connection.onuSerial } : {}),
      ...(cust.connection?.ponPort ? { ponPort: cust.connection.ponPort } : {}),
      ...(cust.phone ? { phone: cust.phone } : {}),
    };
    nodes.push({
      id: `${cust.id}-node`,
      name: cust.fullName,
      type: 'customer',
      status: CUST_STATUS[cust.status] ?? 'unknown',
      lat: pole.lat + ((i % 3) - 1) * 0.0016,
      lng: pole.lng + ((((i / 3) | 0) % 3) - 1) * 0.0018,
      parentId: pole.id,
      meta,
    });
  });

  return nodes;
}
