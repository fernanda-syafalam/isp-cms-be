/**
 * DEMO seed — standalone, destructive when explicitly armed.
 *
 * Populates a realistic-medium Indonesian ISP dataset (~100 customers, a
 * reseller/mitra hierarchy, hundreds of invoices across every billing
 * state, tickets/SLA/work-orders, inventory, vouchers, ...) so the whole
 * product can be demoed to a client from one clean database.
 *
 * SAFETY: this script only acts when `SEED_WIPE=true`. Any other value
 * (including unset) logs a skip message and exits 0 — safe to leave wired
 * into a deploy pipeline permanently. When armed, it WIPES every table
 * (TRUNCATE ... RESTART IDENTITY CASCADE) and repopulates from scratch, so
 * it is idempotent: re-running with SEED_WIPE=true always yields the same
 * shape of data (same counts, same archetypes, same enum coverage) — only
 * generated ids and "now"-relative dates differ.
 *
 * Deliberately NOT seeded here (see the report from the task that added
 * this file for the full rationale): topology/OSP cabling, devices, NOC
 * monitoring/alerts, ODP capacity fixture from `odp.fixtures.ts`, ACS/CPE,
 * coverage areas, announcements, notification templates, audit log,
 * app security (2FA/sessions) and `app_settings`'s own DEFAULTS constant.
 * All of those are "mock-first" self-seeding islands (ADR-0003): each
 * repository's own `ensureSeeded()`/`getOrCreate()` inserts its canned
 * fixture rows, `onConflictDoNothing`, the first time its module is read
 * — so they populate automatically the moment an operator opens that
 * page, with zero risk of this script fighting the app's own idempotent
 * seed. This script DOES seed `app_settings` (a plain singleton upsert)
 * with the demo company identity so the brand is not left as the
 * hard-coded "Jepara Net" placeholder during a client walkthrough, and
 * seeds its OWN `odp_records` rows (Jakarta/Bandung/Surabaya) so
 * `customers.odpId` has real FKs to point at — these coexist peacefully
 * with the app's own 12-row Jepara ODP fixture once `GET /odp` is first
 * hit (different, non-colliding ids), which is a known, intentional
 * side-effect of the mock-first pattern, not a bug in this script.
 *
 * Run:
 *   pnpm db:up && pnpm db:migrate
 *   SEED_WIPE=true DATABASE_URL=postgres://app:app@localhost:5432/app \
 *     pnpm tsx src/infrastructure/database/seed-demo.ts
 *
 * Or, in the built image:
 *   SEED_WIPE=true node dist/infrastructure/database/seed-demo.js
 *
 * Standalone by design (mirrors seed.ts / migrate.ts): imports only the
 * Drizzle schema, argon2, drizzle-orm/node-postgres and pg — no Nest
 * modules, no service/repository imports — so it stays trivially
 * portable if a future Go rewrite needs an equivalent one-off loader.
 */
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import type {
  Customer,
  CustomerConnection,
  NewBranch,
  NewContract,
  NewCustomer,
  NewInventoryItem,
  NewInvoice,
  NewIpPool,
  NewLead,
  NewOdpRecord,
  NewPayment,
  NewPaymentIntent,
  NewPlan,
  NewPppProfile,
  NewPppSecret,
  NewReseller,
  NewResellerLedgerEntry,
  NewResellerPayout,
  NewRouter,
  NewSimpleQueue,
  NewSlaCredit,
  NewStockMovement,
  NewTicket,
  NewTicketEvent,
  NewUser,
  NewVoucher,
  NewWorkOrder,
} from './schema';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // Fail loud, fail fast — never fall back to a default localhost DB for a
  // destructive script (mirrors migrate.ts).
  throw new Error('DATABASE_URL is required to run the demo seed');
}

// Mirrors src/modules/users/users.service.ts ARGON2_OPTIONS exactly, so the
// seeded hashes verify through the real login path.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// Shared demo password for every seeded login. DEMO / LOCAL USE ONLY.
const DEMO_PASSWORD = 'DemoAshnet!2026';

const NOW = new Date();

// Every table this script owns end-to-end, in an order TRUNCATE...CASCADE
// does not actually need (CASCADE resolves FK order itself) but that is kept
// dependency-ordered anyway for readability. Static, hard-coded list — never
// built from user input, so a plain (non-parameterized) SQL string is safe
// here (the general "no sql.raw with user input" rule is about *dynamic*
// identifiers, not this kind of fixed constant).
const ALL_TABLES = [
  'user_sessions',
  'user_security',
  'audit_log',
  'notification_log',
  'notification_templates',
  'announcements',
  'alerts',
  'device_metrics',
  'coverage_areas',
  'devices',
  'acs_devices',
  'splices',
  'splitters',
  'closures',
  'strands',
  'cables',
  'circuits',
  'network_nodes',
  'stock_movements',
  'inventory_items',
  'sla_credits',
  'ticket_events',
  'tickets',
  'work_orders',
  'contracts',
  'payment_intents',
  'payments',
  'invoices',
  'ppp_secrets',
  'ppp_profiles',
  'simple_queues',
  'ip_pools',
  'routers',
  'vouchers',
  'reseller_payouts',
  'reseller_ledger',
  'leads',
  'customers',
  'odp_records',
  'plans',
  'branches',
  'users',
  'resellers',
  'app_settings',
] as const;

// Standalone sequences (`pgSequence`, not `GENERATED ALWAYS AS IDENTITY`) are
// never "owned" by a column, so `TRUNCATE ... RESTART IDENTITY` does not
// reset them — they must be restarted explicitly to keep re-seeds producing
// the same human-facing numbers (CUST-9001, INV-2026-100, ...).
const SEQUENCES_TO_RESTART: Array<{ name: string; startWith: number }> = [
  { name: 'customer_no_seq', startWith: 9001 },
  { name: 'invoice_no_seq', startWith: 100 },
  { name: 'ticket_code_seq', startWith: 2001 },
  { name: 'work_order_code_seq', startWith: 9001 },
  { name: 'contract_no_seq', startWith: 1 },
];

// ---------------------------------------------------------------------------
// Small date helpers (all UTC, all deterministic given `NOW`)
// ---------------------------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addMonths(d: Date, months: number): Date {
  const copy = new Date(d);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Name / address fixtures (Indonesian, deterministic index-based pick — no
// randomness, so two runs with SEED_WIPE=true produce the same shape).
// ---------------------------------------------------------------------------

const MALE_NAMES = [
  'Budi',
  'Agus',
  'Dedi',
  'Eko',
  'Bambang',
  'Hendra',
  'Joko',
  'Rudi',
  'Slamet',
  'Wahyu',
  'Andi',
  'Bayu',
  'Fajar',
  'Gilang',
  'Hadi',
  'Iwan',
  'Krisna',
  'Made',
  'Nanda',
  'Oscar',
  'Yusuf',
  'Zainal',
  'Rian',
  'Tommy',
  'Sigit',
];
const FEMALE_NAMES = [
  'Siti',
  'Rina',
  'Ani',
  'Citra',
  'Dewi',
  'Fitri',
  'Gita',
  'Hesti',
  'Indah',
  'Kartika',
  'Lestari',
  'Maya',
  'Nina',
  'Putri',
  'Ratna',
  'Sari',
  'Tuti',
  'Umi',
  'Wulan',
  'Yuni',
  'Anggun',
  'Devi',
  'Melati',
  'Novita',
  'Wening',
];
const LAST_NAMES = [
  'Santoso',
  'Wijaya',
  'Kurniawan',
  'Saputra',
  'Pratama',
  'Hidayat',
  'Nugroho',
  'Setiawan',
  'Purnomo',
  'Wibowo',
  'Utomo',
  'Susanto',
  'Firmansyah',
  'Gunawan',
  'Halim',
  'Iskandar',
  'Kusuma',
  'Lubis',
  'Maulana',
  'Ramadhan',
];

function fullNameFor(i: number): string {
  const isMale = i % 2 === 0;
  const first = isMale ? MALE_NAMES[i % MALE_NAMES.length] : FEMALE_NAMES[i % FEMALE_NAMES.length];
  const last = LAST_NAMES[(i * 3 + 7) % LAST_NAMES.length];
  return `${first} ${last}`;
}

type CityArea = { kelurahan: string; kecamatan: string; city: string };

const JAKARTA_AREAS: CityArea[] = [
  { kelurahan: 'Kemang', kecamatan: 'Mampang Prapatan', city: 'Jakarta Selatan' },
  { kelurahan: 'Cipete Selatan', kecamatan: 'Cilandak', city: 'Jakarta Selatan' },
  { kelurahan: 'Menteng', kecamatan: 'Menteng', city: 'Jakarta Pusat' },
  { kelurahan: 'Tebet Timur', kecamatan: 'Tebet', city: 'Jakarta Selatan' },
  { kelurahan: 'Cempaka Putih', kecamatan: 'Cempaka Putih', city: 'Jakarta Pusat' },
  { kelurahan: 'Kelapa Gading Barat', kecamatan: 'Kelapa Gading', city: 'Jakarta Utara' },
];
const BANDUNG_AREAS: CityArea[] = [
  { kelurahan: 'Dago', kecamatan: 'Coblong', city: 'Bandung' },
  { kelurahan: 'Antapani Kidul', kecamatan: 'Antapani', city: 'Bandung' },
  { kelurahan: 'Cibeunying Kidul', kecamatan: 'Cibeunying Kidul', city: 'Bandung' },
  { kelurahan: 'Sukajadi', kecamatan: 'Sukajadi', city: 'Bandung' },
];
const SURABAYA_AREAS: CityArea[] = [
  { kelurahan: 'Rungkut Kidul', kecamatan: 'Rungkut', city: 'Surabaya' },
  { kelurahan: 'Gubeng', kecamatan: 'Gubeng', city: 'Surabaya' },
  { kelurahan: 'Wonokromo', kecamatan: 'Wonokromo', city: 'Surabaya' },
  { kelurahan: 'Sukolilo', kecamatan: 'Sukolilo', city: 'Surabaya' },
];

const CITY_AREA_POOLS = [JAKARTA_AREAS, BANDUNG_AREAS, SURABAYA_AREAS];
// Roughly the real-world centroid of each city — customer pins scatter a
// small deterministic offset around these so the topology/coverage map
// clusters into three recognizable metro areas instead of one blob.
const CITY_CENTROIDS: Array<{ lat: number; lng: number }> = [
  { lat: -6.2615, lng: 106.8106 }, // Jakarta Selatan-ish
  { lat: -6.9147, lng: 107.6098 }, // Bandung
  { lat: -7.2905, lng: 112.7325 }, // Surabaya
];

function areaFor(i: number): CityArea {
  const pool = CITY_AREA_POOLS[i % CITY_AREA_POOLS.length] ?? JAKARTA_AREAS;
  return pool[i % pool.length] ?? pool[0];
}

function latLngFor(i: number): { lat: number; lng: number } {
  const centroid = CITY_CENTROIDS[i % CITY_CENTROIDS.length] ?? CITY_CENTROIDS[0];
  // Deterministic small jitter (+/- ~0.03 deg, a few km) so pins do not stack.
  const jitterLat = (((i * 37) % 60) - 30) / 1000;
  const jitterLng = (((i * 53) % 60) - 30) / 1000;
  return { lat: centroid.lat + jitterLat, lng: centroid.lng + jitterLng };
}

function phoneFor(i: number): string {
  const local = (812_000_0000 + i * 137) % 900_000_0000;
  return `+62${String(8_120_000_000 + local).slice(0, 11)}`;
}

function addressFor(i: number, area: CityArea): string {
  const streetNo = 1 + (i % 48);
  return `Jl. Melati No. ${streetNo}, Kel. ${area.kelurahan}, Kec. ${area.kecamatan}, ${area.city}`;
}

function ktpFor(i: number): string {
  // Deterministic 16-digit NIK-shaped placeholder — never a real NIK.
  return `3271${String(1_000_000_000 + i * 9173).padStart(12, '0')}`;
}

// PPPoE login derived from the account number, mirroring
// `WorkOrdersService`'s own `pppoeUsername()` so the convention matches
// exactly what the app itself would have generated.
function pppoeUsernameFor(customerNo: string): string {
  return customerNo.toLowerCase().replace('-', '');
}

// ---------------------------------------------------------------------------
// Reference / dimension data
// ---------------------------------------------------------------------------

const RESELLER_SPECS: Array<NewReseller & { id: string }> = [
  {
    id: randomUUID(),
    name: 'Reseller Kemang Jaya',
    area: 'Jakarta Selatan',
    balance: 0,
    commissionPct: 0.05,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Mitra Dago Net',
    area: 'Bandung',
    balance: 0,
    commissionPct: 0.07,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Reseller Rungkut Sejahtera',
    area: 'Surabaya',
    balance: 0,
    commissionPct: 0.06,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Mitra Antapani Fiber',
    area: 'Bandung',
    balance: 0,
    commissionPct: 0.05,
    status: 'inactive',
  },
];
// Index into RESELLER_SPECS the `mitra@astaweda.com` login is scoped to
// (ADR-0010: a mitra principal is scoped to exactly one reseller).
const MITRA_RESELLER_INDEX = 0;

const BRANCH_SPECS: NewBranch[] = [
  {
    name: 'Kantor Pusat Jakarta',
    city: 'Jakarta Selatan',
    manager: 'Herman Wijaya',
    phone: '+622179180001',
    status: 'active',
    isHeadOffice: true,
    customerCount: 42,
    mrr: 14_250_000,
    deviceCount: 26,
  },
  {
    name: 'Cabang Bandung',
    city: 'Bandung',
    manager: 'Rosa Andriani',
    phone: '+62224230002',
    status: 'active',
    isHeadOffice: false,
    customerCount: 31,
    mrr: 9_800_000,
    deviceCount: 18,
  },
  {
    name: 'Cabang Surabaya',
    city: 'Surabaya',
    manager: 'Fajar Ramadhan',
    phone: '+62315470003',
    status: 'active',
    isHeadOffice: false,
    customerCount: 27,
    mrr: 8_450_000,
    deviceCount: 15,
  },
  {
    name: 'Cabang Jepara (Legacy)',
    city: 'Jepara',
    manager: 'Sutrisno',
    phone: '+622915910004',
    status: 'inactive',
    isHeadOffice: false,
    customerCount: 0,
    mrr: 0,
    deviceCount: 2,
  },
];

// 4 sellable tiers + 1 archived legacy tier still referenced by long-tenure
// customers (plans are archived, never deleted — Pilar re: FK survival).
const PLAN_SPECS: Array<NewPlan & { id: string }> = [
  {
    id: randomUUID(),
    name: 'Paket Home 20 Mbps',
    speedMbps: 20,
    priceMonthly: 149_000,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Paket Home 30 Mbps',
    speedMbps: 30,
    priceMonthly: 199_000,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Paket Home 50 Mbps',
    speedMbps: 50,
    priceMonthly: 299_000,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Paket Home 100 Mbps',
    speedMbps: 100,
    priceMonthly: 499_000,
    status: 'active',
  },
  {
    id: randomUUID(),
    name: 'Paket Home 10 Mbps (Legacy)',
    speedMbps: 10,
    priceMonthly: 129_000,
    status: 'archived',
  },
];
const ACTIVE_PLAN_COUNT = 4; // legacy plan (index 4) is only ever assigned to a few long-tenure customers.

// 14 distribution points across the 3 metro areas. Ids/names are deliberately
// distinct from `odp.fixtures.ts`'s `buildOdpFixture()` (see the file header)
// so the two seed sources never collide.
function buildOdpSpecs(): Array<NewOdpRecord & { id: string }> {
  const areas: Array<{ id: string; name: string; area: string }> = [
    { id: 'odp-jkt-kemang-01', name: 'ODP-JKT-KEMANG-01', area: 'Jakarta Selatan' },
    { id: 'odp-jkt-kemang-02', name: 'ODP-JKT-KEMANG-02', area: 'Jakarta Selatan' },
    { id: 'odp-jkt-cipete-01', name: 'ODP-JKT-CIPETE-01', area: 'Jakarta Selatan' },
    { id: 'odp-jkt-menteng-01', name: 'ODP-JKT-MENTENG-01', area: 'Jakarta Pusat' },
    { id: 'odp-jkt-tebet-01', name: 'ODP-JKT-TEBET-01', area: 'Jakarta Selatan' },
    { id: 'odp-jkt-gading-01', name: 'ODP-JKT-GADING-01', area: 'Jakarta Utara' },
    { id: 'odp-bdg-dago-01', name: 'ODP-BDG-DAGO-01', area: 'Bandung' },
    { id: 'odp-bdg-antapani-01', name: 'ODP-BDG-ANTAPANI-01', area: 'Bandung' },
    { id: 'odp-bdg-cibeunying-01', name: 'ODP-BDG-CIBEUNYING-01', area: 'Bandung' },
    { id: 'odp-bdg-sukajadi-01', name: 'ODP-BDG-SUKAJADI-01', area: 'Bandung' },
    { id: 'odp-sby-rungkut-01', name: 'ODP-SBY-RUNGKUT-01', area: 'Surabaya' },
    { id: 'odp-sby-gubeng-01', name: 'ODP-SBY-GUBENG-01', area: 'Surabaya' },
    { id: 'odp-sby-wonokromo-01', name: 'ODP-SBY-WONOKROMO-01', area: 'Surabaya' },
    { id: 'odp-sby-sukolilo-01', name: 'ODP-SBY-SUKOLILO-01', area: 'Surabaya' },
  ];
  return areas.map((a, i) => {
    const is16 = i % 3 === 0;
    const totalPorts = is16 ? 16 : 8;
    const usedPorts = Math.min(totalPorts, 3 + ((i * 5) % (totalPorts - 1)));
    // -17..-31 dBm, walking through healthy -> warning -> a few critical.
    const rx = -17 - (i % 11) - (i % 4 === 0 ? 4 : 0);
    const status: NewOdpRecord['status'] =
      rx >= -25 ? 'healthy' : rx >= -27 ? 'warning' : 'critical';
    return {
      id: a.id,
      name: a.name,
      area: a.area,
      splitter: is16 ? '1:16' : '1:8',
      totalPorts,
      usedPorts,
      avgRxPowerDbm: rx,
      status,
    };
  });
}

// 3 city-core Mikrotik routers. One (Surabaya) is deliberately `offline` so
// the NOC/router list is not an all-green demo.
function buildRouterSpecs(): Array<NewRouter & { id: string; city: string }> {
  return [
    {
      id: randomUUID(),
      city: 'Jakarta',
      name: 'MKT-CORE-JKT-01',
      address: '10.10.1.1',
      apiPort: 8728,
      username: 'api-readonly',
      model: 'CCR2004-1G-12S+2XS',
      version: '7.15.1',
      status: 'online',
      secretCount: 0, // set for real once ppp_secrets are built below.
      lastSyncAt: NOW,
    },
    {
      id: randomUUID(),
      city: 'Bandung',
      name: 'MKT-CORE-BDG-01',
      address: '10.10.2.1',
      apiPort: 8728,
      username: 'api-readonly',
      model: 'CCR2004-1G-12S+2XS',
      version: '7.15.1',
      status: 'online',
      secretCount: 0,
      lastSyncAt: NOW,
    },
    {
      id: randomUUID(),
      city: 'Surabaya',
      name: 'MKT-CORE-SBY-01',
      address: '10.10.3.1',
      apiPort: 8728,
      username: 'api-readonly',
      model: 'RB4011iGS+',
      version: '7.14.3',
      status: 'offline',
      secretCount: 0,
      lastSyncAt: addDays(NOW, -2),
    },
  ];
}

// One rate-limited profile per sellable plan tier, plus the shared isolir
// throttle profile — per router (RouterOS profiles are per-device).
function buildPppProfileSpecs(
  routers: Array<{ id: string }>,
): Array<NewPppProfile & { id: string; tier: string | 'isolir' }> {
  const tiers: Array<{ tier: string; rateLimit: string }> = [
    { tier: 'Home 20', rateLimit: '20M/20M' },
    { tier: 'Home 30', rateLimit: '30M/30M' },
    { tier: 'Home 50', rateLimit: '50M/50M' },
    { tier: 'Home 100', rateLimit: '100M/100M' },
  ];
  const specs: Array<NewPppProfile & { id: string; tier: string | 'isolir' }> = [];
  for (const router of routers) {
    for (const t of tiers) {
      specs.push({
        id: randomUUID(),
        routerId: router.id,
        name: t.tier,
        rateLimit: t.rateLimit,
        isIsolir: false,
        tier: t.tier,
      });
    }
    specs.push({
      id: randomUUID(),
      routerId: router.id,
      name: 'Isolir',
      rateLimit: '512k/512k',
      isIsolir: true,
      tier: 'isolir',
    });
  }
  return specs;
}

function buildSimpleQueueSpecs(routers: Array<{ id: string; city: string }>): NewSimpleQueue[] {
  const specs: NewSimpleQueue[] = [];
  for (const router of routers) {
    const tiers = [
      { name: 'QoS Home 20', maxLimit: '20M/20M' },
      { name: 'QoS Home 30', maxLimit: '30M/30M' },
      { name: 'QoS Home 50', maxLimit: '50M/50M' },
      { name: 'QoS Home 100', maxLimit: '100M/100M' },
      { name: 'QoS Hotspot', maxLimit: '10M/10M' },
    ];
    for (const t of tiers) {
      specs.push({
        routerId: router.id,
        name: `${t.name} - ${router.city}`,
        target: `${router.city.toLowerCase()}-pool/24`,
        maxLimit: t.maxLimit,
      });
    }
  }
  return specs;
}

function buildIpPoolSpecs(routers: Array<{ id: string; city: string }>): NewIpPool[] {
  const specs: NewIpPool[] = [];
  routers.forEach((router, i) => {
    specs.push({
      routerId: router.id,
      name: `pool-pppoe-${router.city.toLowerCase()}`,
      ranges: `100.64.${100 + i}.10-100.64.${100 + i}.250`,
      totalAddresses: 240,
      usedAddresses: 0, // patched below once ppp_secrets per router are known.
    });
    specs.push({
      routerId: router.id,
      name: `pool-hotspot-${router.city.toLowerCase()}`,
      ranges: `10.${20 + i}.0.10-10.${20 + i}.0.250`,
      totalAddresses: 240,
      usedAddresses: 40,
    });
  });
  return specs;
}

// ---------------------------------------------------------------------------
// Users — one login per role (product-owner-mandated emails) + a handful of
// extra customer-portal accounts, all sharing DEMO_PASSWORD.
// ---------------------------------------------------------------------------

type SeedUserSpec = Omit<NewUser, 'passwordHash'> & { id: string };

function buildUserSpecs(mitraResellerId: string): SeedUserSpec[] {
  return [
    {
      id: randomUUID(),
      email: 'admin@astaweda.com',
      fullName: 'Admin Astaweda',
      role: 'admin',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'staff@astaweda.com',
      fullName: 'Siti Rahayu',
      role: 'staff',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'teknisi@astaweda.com',
      fullName: 'Dedi Kurniawan',
      role: 'teknisi',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'mitra@astaweda.com',
      fullName: 'Bambang Wirawan',
      role: 'mitra',
      resellerId: mitraResellerId,
    },
    // Primary + 4 extra portal logins — each linked to a distinct customer
    // archetype below via CUSTOMER_LOGIN_LINKS so the portal demo shows
    // clean/due-soon/partial/isolir/sla-credit states across 5 real accounts.
    {
      id: randomUUID(),
      email: 'customer@astaweda.com',
      fullName: 'Rina Marlina',
      role: 'customer',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'customer2@astaweda.com',
      fullName: 'Yusuf Hidayat',
      role: 'customer',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'customer3@astaweda.com',
      fullName: 'Novita Halim',
      role: 'customer',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'customer4@astaweda.com',
      fullName: 'Tommy Iskandar',
      role: 'customer',
      resellerId: null,
    },
    {
      id: randomUUID(),
      email: 'customer5@astaweda.com',
      fullName: 'Wening Kusuma',
      role: 'customer',
      resellerId: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Customers — 100 rows across 8 archetypes (fixed-size, fixed-order blocks
// so the same index always maps to the same archetype across re-seeds).
// ---------------------------------------------------------------------------

type CustomerArchetype =
  | 'prospek'
  | 'instalasi'
  | 'aktif-good'
  | 'aktif-duesoon'
  | 'aktif-partial'
  | 'aktif-slacredit'
  | 'isolir'
  | 'berhenti';

const ARCHETYPE_BLOCKS: Array<{ archetype: CustomerArchetype; count: number }> = [
  { archetype: 'prospek', count: 5 },
  { archetype: 'instalasi', count: 5 },
  { archetype: 'aktif-good', count: 45 },
  { archetype: 'aktif-duesoon', count: 10 },
  { archetype: 'aktif-partial', count: 8 },
  { archetype: 'aktif-slacredit', count: 7 },
  { archetype: 'isolir', count: 12 },
  { archetype: 'berhenti', count: 8 },
];

function buildArchetypePlan(): CustomerArchetype[] {
  const plan: CustomerArchetype[] = [];
  for (const block of ARCHETYPE_BLOCKS) {
    for (let n = 0; n < block.count; n += 1) plan.push(block.archetype);
  }
  return plan;
}

// Global index -> emails from buildUserSpecs, one real customer per portal
// login so each shows a different billing state from the portal's POV.
const CUSTOMER_LOGIN_LINKS: Record<number, string> = {
  10: 'customer@astaweda.com', // first aktif-good: clean payment history
  55: 'customer2@astaweda.com', // first aktif-duesoon: invoice due soon
  65: 'customer3@astaweda.com', // first aktif-partial: partially paid
  80: 'customer4@astaweda.com', // first isolir: overdue / suspended
  73: 'customer5@astaweda.com', // first aktif-slacredit: SLA credit applied
};

interface CustomerPlan {
  index: number;
  archetype: CustomerArchetype;
  fullName: string;
  area: CityArea;
  cityIndex: number;
  planId: string;
  planPriceMonthly: number;
  resellerId: string | null;
  odpId: string | null;
  connectionType: 'gpon' | 'pppoe' | null; // null = not yet provisioned
  isProvisioned: boolean;
  rxPower: number | null;
}

function buildCustomerPlans(
  plans: Array<{ id: string; priceMonthly: number }>,
  resellers: Array<{ id: string }>,
  odps: Array<{ id: string; area: string }>,
): CustomerPlan[] {
  const archetypes = buildArchetypePlan();
  const jakartaOdps = odps.filter((o) => o.area.startsWith('Jakarta'));
  const bandungOdps = odps.filter((o) => o.area === 'Bandung');
  const surabayaOdps = odps.filter((o) => o.area === 'Surabaya');
  const odpPools = [jakartaOdps, bandungOdps, surabayaOdps];

  return archetypes.map((archetype, i) => {
    const cityIndex = i % 3;
    const area = areaFor(i);
    // 1 in 23 long-tenure customers rides the archived legacy plan; the rest
    // cycle the 4 active tiers.
    const plan = i % 23 === 0 ? plans[4] : plans[i % ACTIVE_PLAN_COUNT];
    if (!plan) throw new Error('plan pool misconfigured');

    // Reseller book-of-business: fixed, non-overlapping index ranges (see
    // file header commentary for why) rather than modulo, so each mitra's
    // portfolio is a contiguous, explainable slice.
    let resellerId: string | null = null;
    if (i >= 10 && i < 30)
      resellerId = resellers[0]?.id ?? null; // Kemang Jaya (mitra-scoped)
    else if (i >= 30 && i < 45)
      resellerId = resellers[1]?.id ?? null; // Dago Net
    else if (i >= 45 && i < 55)
      resellerId = resellers[2]?.id ?? null; // Rungkut Sejahtera
    else if (i >= 80 && i < 84) resellerId = resellers[3]?.id ?? null; // Antapani (inactive) -> now-isolir book

    // Prospects have no drop yet. Everyone from `instalasi` onward has a
    // port reserved at onboarding, even before physical turn-up.
    const isPppoeOnly = i % 5 === 0;
    let odpId: string | null = null;
    if (i >= 5 && !isPppoeOnly) {
      const pool = odpPools[cityIndex] ?? [];
      odpId = pool.length > 0 ? (pool[i % pool.length]?.id ?? null) : null;
    }

    // Only aktif/isolir/berhenti are actually provisioned (a live connection).
    const isProvisioned = i >= 10;
    const connectionType: 'gpon' | 'pppoe' | null = isProvisioned
      ? isPppoeOnly
        ? 'pppoe'
        : 'gpon'
      : null;

    // -18..-26 dBm normally; force a handful of weak/critical readings.
    let rxPower: number | null = null;
    if (isProvisioned && connectionType === 'gpon') {
      rxPower = -18 - (i % 8);
      if (i % 17 === 0) rxPower = -29 - (i % 3); // deliberately weak/critical
    }

    return {
      index: i,
      archetype,
      fullName: fullNameFor(i),
      area,
      cityIndex,
      planId: plan.id,
      planPriceMonthly: plan.priceMonthly,
      resellerId,
      odpId,
      connectionType,
      isProvisioned,
      rxPower,
    };
  });
}

// ---------------------------------------------------------------------------
// Billing history per customer — invoices + payments (+ a couple of payment
// intents), covering every invoice_status and every payment_method.
// ---------------------------------------------------------------------------

const PPN_RATE = 0.11;
const LATE_FEE_IDR = 25_000;
const SLA_CREDIT_AMOUNT_IDR = 50_000;
const PAYMENT_METHODS: Array<NewPayment['method']> = ['qris', 'va', 'ewallet', 'transfer', 'cash'];
const PAYMENT_CHANNELS: Array<NewPaymentIntent['channel']> = [
  'qris',
  'va_bca',
  'va_mandiri',
  'va_bri',
  'va_bni',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
];

function periodFor(monthsAgo: number): { start: string; end: string; startDate: Date } {
  const ref = addMonths(startOfMonth(NOW), -monthsAgo);
  return { start: ymd(ref), end: ymd(endOfMonth(ref)), startDate: ref };
}

interface InvoiceRow {
  id: string;
  customerId: string;
  customerName: string;
  type: NewInvoice['type'];
  note: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  lateFee: number;
  taxAmount: number;
  discountAmount: number;
  paidAmount: number;
  status: NewInvoice['status'];
  dueDate: string;
  paidAt: Date | null;
  createdAt: Date;
}

function makeInvoice(params: {
  customerId: string;
  customerName: string;
  type?: NewInvoice['type'];
  note?: string | null;
  period: { start: string; end: string };
  amount: number;
  lateFee?: number;
  discountAmount?: number;
  paidAmount?: number;
  status: NewInvoice['status'];
  dueDateObj: Date;
  paidAt?: Date | null;
}): InvoiceRow {
  const taxAmount = Math.round(params.amount * PPN_RATE);
  return {
    id: randomUUID(),
    customerId: params.customerId,
    customerName: params.customerName,
    type: params.type ?? 'regular',
    note: params.note ?? null,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    amount: params.amount,
    lateFee: params.lateFee ?? 0,
    taxAmount,
    discountAmount: params.discountAmount ?? 0,
    paidAmount: params.paidAmount ?? 0,
    status: params.status,
    dueDate: ymd(params.dueDateObj),
    paidAt: params.paidAt ?? null,
    createdAt: addDays(params.dueDateObj, -10),
  };
}

function invoiceTotal(inv: InvoiceRow): number {
  return inv.amount + inv.lateFee + inv.taxAmount - inv.discountAmount;
}

interface PaymentRow {
  invoiceId: string;
  invoiceNo: null; // resolved by the DB after invoices are inserted — see main().
  customerId: string;
  customerName: string;
  amount: number;
  method: NewPayment['method'];
  tenderedAmount: number | null;
  changeAmount: number | null;
  paidAt: Date;
}

interface BillingResult {
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  outstanding: number;
  slaCreditInvoiceId: string | null; // set only for aktif-slacredit
}

function buildBilling(customer: CustomerPlan, customerId: string): BillingResult {
  const invoices: InvoiceRow[] = [];
  const payments: PaymentRow[] = [];
  const amount = customer.planPriceMonthly;
  const methodFor = (k: number) =>
    PAYMENT_METHODS[(customer.index + k) % PAYMENT_METHODS.length] ?? 'qris';

  const payFull = (inv: InvoiceRow, paidAtOffsetDays: number) => {
    const total = invoiceTotal(inv);
    inv.paidAmount = total;
    inv.status = 'paid';
    const paidAt = addDays(new Date(inv.dueDate), paidAtOffsetDays);
    inv.paidAt = paidAt;
    const method = methodFor(invoices.length);
    payments.push({
      invoiceId: inv.id,
      invoiceNo: null,
      customerId,
      customerName: customer.fullName,
      amount: total,
      method,
      tenderedAmount: method === 'cash' ? total + 5_000 : null,
      changeAmount: method === 'cash' ? 5_000 : null,
      paidAt,
    });
  };

  switch (customer.archetype) {
    case 'prospek':
    case 'instalasi':
      return { invoices: [], payments: [], outstanding: 0, slaCreditInvoiceId: null };

    case 'aktif-good':
    case 'aktif-duesoon': {
      for (let k = 3; k >= 1; k -= 1) {
        const { start, end, startDate } = periodFor(k);
        const inv = makeInvoice({
          customerId,
          customerName: customer.fullName,
          period: { start, end },
          amount,
          status: 'pending', // flipped to paid immediately below
          dueDateObj: addDays(startDate, 10),
        });
        payFull(inv, k % 2 === 0 ? -2 : 1);
        invoices.push(inv);
      }
      const current = periodFor(0);
      const dueInDays = customer.archetype === 'aktif-duesoon' ? 2 : 12;
      const currentInvoice = makeInvoice({
        customerId,
        customerName: customer.fullName,
        period: { start: current.start, end: current.end },
        amount,
        status: 'pending',
        dueDateObj: addDays(NOW, dueInDays),
      });
      invoices.push(currentInvoice);
      return {
        invoices,
        payments,
        outstanding: invoiceTotal(currentInvoice),
        slaCreditInvoiceId: null,
      };
    }

    case 'aktif-partial': {
      for (let k = 3; k >= 1; k -= 1) {
        const { start, end, startDate } = periodFor(k);
        const inv = makeInvoice({
          customerId,
          customerName: customer.fullName,
          period: { start, end },
          amount,
          status: 'pending',
          dueDateObj: addDays(startDate, 10),
        });
        payFull(inv, -1);
        invoices.push(inv);
      }
      const current = periodFor(0);
      const currentInvoice = makeInvoice({
        customerId,
        customerName: customer.fullName,
        period: { start: current.start, end: current.end },
        amount,
        status: 'partial',
        dueDateObj: addDays(NOW, 5),
      });
      const total = invoiceTotal(currentInvoice);
      const partialAmount = Math.round(total * 0.4);
      currentInvoice.paidAmount = partialAmount;
      const method = methodFor(99);
      payments.push({
        invoiceId: currentInvoice.id,
        invoiceNo: null,
        customerId,
        customerName: customer.fullName,
        amount: partialAmount,
        method,
        tenderedAmount: method === 'cash' ? partialAmount : null,
        changeAmount: method === 'cash' ? 0 : null,
        paidAt: addDays(NOW, -1),
      });
      invoices.push(currentInvoice);
      return {
        invoices,
        payments,
        outstanding: total - partialAmount,
        slaCreditInvoiceId: null,
      };
    }

    case 'aktif-slacredit': {
      for (let k = 3; k >= 1; k -= 1) {
        const { start, end, startDate } = periodFor(k);
        const inv = makeInvoice({
          customerId,
          customerName: customer.fullName,
          period: { start, end },
          amount,
          status: 'pending',
          dueDateObj: addDays(startDate, 10),
        });
        payFull(inv, -2);
        invoices.push(inv);
      }
      const current = periodFor(0);
      const currentInvoice = makeInvoice({
        customerId,
        customerName: customer.fullName,
        period: { start: current.start, end: current.end },
        amount,
        discountAmount: SLA_CREDIT_AMOUNT_IDR,
        status: 'pending',
        dueDateObj: addDays(NOW, 8),
      });
      invoices.push(currentInvoice);
      return {
        invoices,
        payments,
        outstanding: invoiceTotal(currentInvoice),
        slaCreditInvoiceId: currentInvoice.id,
      };
    }

    case 'isolir': {
      const { start, end, startDate } = periodFor(2);
      const paidInv = makeInvoice({
        customerId,
        customerName: customer.fullName,
        period: { start, end },
        amount,
        status: 'pending',
        dueDateObj: addDays(startDate, 10),
      });
      payFull(paidInv, -3);
      invoices.push(paidInv);

      let outstanding = 0;
      for (const [k, daysPastDue] of [
        [1, -45],
        [0, -15],
      ] as const) {
        const p = periodFor(k);
        const inv = makeInvoice({
          customerId,
          customerName: customer.fullName,
          period: { start: p.start, end: p.end },
          amount,
          lateFee: LATE_FEE_IDR,
          status: 'overdue',
          dueDateObj: addDays(NOW, daysPastDue),
        });
        invoices.push(inv);
        outstanding += invoiceTotal(inv);
      }
      return { invoices, payments, outstanding, slaCreditInvoiceId: null };
    }

    case 'berhenti': {
      for (let k = 2; k >= 0; k -= 1) {
        const { start, end, startDate } = periodFor(k + 1); // billed a bit before "now" — they've since churned.
        const inv = makeInvoice({
          customerId,
          customerName: customer.fullName,
          period: { start, end },
          amount,
          status: 'pending',
          dueDateObj: addDays(startDate, 10),
        });
        payFull(inv, -1);
        invoices.push(inv);
      }
      return { invoices, payments, outstanding: 0, slaCreditInvoiceId: null };
    }
  }
}

// One standalone `adjustment` invoice (plan-upgrade proration), attached to
// the first `aktif-good` customer — demonstrates `invoice_type = 'adjustment'`
// without disturbing the regular-period uniqueness invariant.
function buildAdjustmentInvoice(
  customerId: string,
  customerName: string,
): { invoice: InvoiceRow; payment: PaymentRow } {
  const dueDateObj = addDays(NOW, -20);
  const invoice = makeInvoice({
    customerId,
    customerName,
    type: 'adjustment',
    note: 'Proration: Home 20 -> Home 50',
    period: { start: ymd(dueDateObj), end: ymd(dueDateObj) },
    amount: 75_000,
    status: 'pending',
    dueDateObj,
  });
  const total = invoiceTotal(invoice);
  invoice.paidAmount = total;
  invoice.status = 'paid';
  const paidAt = addDays(dueDateObj, 1);
  invoice.paidAt = paidAt;
  const payment: PaymentRow = {
    invoiceId: invoice.id,
    invoiceNo: null,
    customerId,
    customerName,
    amount: total,
    method: 'va',
    tenderedAmount: null,
    changeAmount: null,
    paidAt,
  };
  return { invoice, payment };
}

// ---------------------------------------------------------------------------
// Tickets + timeline events
// ---------------------------------------------------------------------------

interface SeededCustomer {
  id: string;
  index: number;
  archetype: CustomerArchetype;
  fullName: string;
  phone: string;
  address: string;
  areaCity: string;
  planId: string;
  planName: string;
  resellerId: string | null;
  lat: number;
  lng: number;
  onuSerial: string | null;
}

interface TicketRow extends NewTicket {
  id: string;
}

const TICKET_PRIORITIES: Array<NewTicket['priority']> = ['low', 'medium', 'high', 'urgent'];
const TICKET_CATEGORIES: Array<NonNullable<NewTicket['category']>> = [
  'koneksi_putus',
  'lambat',
  'tagihan',
  'perangkat',
  'lainnya',
];
const SLA_HOURS: Record<NewTicket['priority'], number> = {
  urgent: 4,
  high: 8,
  medium: 24,
  low: 72,
};
const STAFF_NAMES = ['Siti Rahayu', 'Andi Saputra', 'Rian Maulana', 'Dedi Kurniawan'];

interface TicketBuildResult {
  tickets: TicketRow[];
  events: NewTicketEvent[];
  // First 7 breached tickets, in customer order — sla_credits links to these.
  slaCreditTickets: Array<{ ticketId: string; ticketCode: null; customerId: string }>;
  // A further pool the work-order repair dispatch draws from.
  repairCandidates: TicketRow[];
}

function buildTickets(
  slaCreditCustomers: SeededCustomer[],
  generalPool: SeededCustomer[],
): TicketBuildResult {
  const tickets: TicketRow[] = [];
  const events: NewTicketEvent[] = [];
  const slaCreditTickets: Array<{ ticketId: string; ticketCode: null; customerId: string }> = [];

  const pushEvents = (ticket: TicketRow, customerLabel: string) => {
    events.push({
      ticketId: ticket.id,
      kind: 'created',
      author: ticket.customerId ? customerLabel : 'Portal',
      body: `Tiket dibuat: ${ticket.subject}`,
      at: ticket.createdAt as Date,
    });
    if (ticket.status !== 'open') {
      events.push({
        ticketId: ticket.id,
        kind: 'assign',
        author: ticket.assignee ?? 'Staff',
        body: `Ditugaskan ke ${ticket.assignee}`,
        at: addDays(ticket.createdAt as Date, 0),
      });
    }
    if (ticket.status === 'resolved' || ticket.status === 'breached') {
      events.push({
        ticketId: ticket.id,
        kind: 'status',
        author: ticket.assignee ?? 'Staff',
        body: `Status diubah menjadi ${ticket.status}`,
        at: ticket.updatedAt as Date,
      });
    }
    if (ticket.csatRating != null) {
      events.push({
        ticketId: ticket.id,
        kind: 'csat',
        author: customerLabel,
        body: `Pelanggan memberi rating ${ticket.csatRating}/5${ticket.csatComment ? `: ${ticket.csatComment}` : ''}`,
        at: ticket.csatAt as Date,
      });
    }
  };

  // 7 dedicated breached tickets, one per aktif-slacredit customer — the
  // narrative source for the SLA credit each of those customers received.
  slaCreditCustomers.forEach((customer, i) => {
    const createdAt = addDays(NOW, -14 - i);
    const slaDueAt = addDays(createdAt, SLA_HOURS.high / 24);
    const csat = i < 3;
    const ticket: TicketRow = {
      id: randomUUID(),
      subject: 'Koneksi putus berulang lebih dari 24 jam',
      customerId: customer.id,
      customerName: customer.fullName,
      priority: 'high',
      status: 'breached',
      assignee: STAFF_NAMES[i % STAFF_NAMES.length],
      slaDueAt,
      category: 'koneksi_putus',
      photoUrl: null,
      csatRating: csat ? 2 : null,
      csatComment: csat ? 'Gangguan lama sekali diperbaiki, untung ada kompensasi.' : null,
      csatAt: csat ? addDays(createdAt, 3) : null,
      createdAt,
      updatedAt: addDays(createdAt, 2),
    };
    tickets.push(ticket);
    pushEvents(ticket, customer.fullName);
    slaCreditTickets.push({ ticketId: ticket.id, ticketCode: null, customerId: customer.id });
  });

  // 38 generic tickets across the rest of the billed customer pool + a few
  // unmatched-name walk-ins (customerId null).
  const GENERIC_STATUSES: Array<NewTicket['status']> = [
    ...Array(9).fill('open'),
    ...Array(8).fill('in_progress'),
    ...Array(18).fill('resolved'),
    ...Array(3).fill('breached'),
  ];
  const CSAT_RATINGS_FOR_RESOLVED = [5, 4, 5, 3, 4, 5, 2, 4, 5, 4, 3, 5, 4, 5, 4];

  let resolvedSeen = 0;
  GENERIC_STATUSES.forEach((status, i) => {
    const pickCustomer = i % 5 === 4 ? null : (generalPool[(i * 2) % generalPool.length] ?? null);
    const priority = TICKET_PRIORITIES[i % TICKET_PRIORITIES.length] ?? 'medium';
    const daysAgo = status === 'open' ? 1 + (i % 5) : 5 + (i % 20);
    const createdAt = addDays(NOW, -daysAgo);
    const slaDueAt = addDays(createdAt, SLA_HOURS[priority] / 24);
    const category = i % 2 === 0 ? (TICKET_CATEGORIES[i % TICKET_CATEGORIES.length] ?? null) : null;
    let csatRating: number | null = null;
    let csatComment: string | null = null;
    let csatAt: Date | null = null;
    if (status === 'resolved' && resolvedSeen < CSAT_RATINGS_FOR_RESOLVED.length) {
      csatRating = CSAT_RATINGS_FOR_RESOLVED[resolvedSeen] ?? 4;
      csatComment =
        csatRating >= 4 ? 'Cepat ditangani, terima kasih.' : 'Agak lama tapi akhirnya selesai.';
      csatAt = addDays(createdAt, 2);
      resolvedSeen += 1;
    }
    const ticket: TicketRow = {
      id: randomUUID(),
      subject: TICKET_SUBJECTS[i % TICKET_SUBJECTS.length] ?? 'Kendala layanan',
      customerId: pickCustomer?.id ?? null,
      customerName: pickCustomer?.fullName ?? `Pelapor ${1000 + i}`,
      priority,
      status,
      assignee: status === 'open' ? null : STAFF_NAMES[i % STAFF_NAMES.length],
      slaDueAt,
      category: pickCustomer ? category : null,
      photoUrl: pickCustomer && category ? 'https://cdn.astaweda.com/tickets/report.jpg' : null,
      csatRating,
      csatComment,
      csatAt,
      createdAt,
      updatedAt: status === 'open' ? createdAt : addDays(createdAt, 2),
    };
    tickets.push(ticket);
    pushEvents(ticket, pickCustomer?.fullName ?? ticket.customerName);
  });

  const repairCandidates = tickets.filter(
    (t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'breached',
  );
  return { tickets, events, slaCreditTickets, repairCandidates };
}

const TICKET_SUBJECTS = [
  'Internet lambat saat jam malam',
  'WiFi sering putus-nyambung',
  'Tagihan tidak sesuai paket',
  'ONU lampu LOS menyala merah',
  'Minta pindah lokasi pemasangan',
  'Kecepatan tidak sesuai paket berlangganan',
  'Router perlu direset ulang',
  'Komplain teknisi belum datang',
  'Permintaan upgrade paket',
  'Gangguan total, tidak ada koneksi',
];

// ---------------------------------------------------------------------------
// Contracts (PKS) — one per customer that has reached at least `instalasi`.
// ---------------------------------------------------------------------------

function buildContract(
  customer: SeededCustomer,
  archetype: CustomerArchetype,
  planName: string,
): NewContract {
  if (archetype === 'instalasi') {
    // A couple stay in draft, the rest are sent-but-unsigned — covers all
    // 3 contract_status values across the whole dataset.
    const status: NewContract['status'] = customer.index % 2 === 0 ? 'sent' : 'draft';
    return {
      customerId: customer.id,
      customerName: customer.fullName,
      planName,
      status,
      meterai: false,
      signedAt: null,
    };
  }
  const signedAt = addDays(NOW, -30 - (customer.index % 200));
  return {
    customerId: customer.id,
    customerName: customer.fullName,
    planName,
    status: 'signed',
    meterai: true,
    signedAt,
  };
}

// ---------------------------------------------------------------------------
// Work orders — install (instalasi pipeline + historical installs), repair
// (dispatched from tickets), dismantle (churned customers).
// ---------------------------------------------------------------------------

interface WorkOrderRow extends NewWorkOrder {
  id: string;
}

function buildInstallWorkOrders(
  instalasiCustomers: SeededCustomer[],
  historicalInstallCustomers: SeededCustomer[],
): WorkOrderRow[] {
  const rows: WorkOrderRow[] = [];
  instalasiCustomers.forEach((c, i) => {
    const scheduled = i < 3;
    rows.push({
      id: randomUUID(),
      type: 'install',
      customerId: c.id,
      customerName: c.fullName,
      technician: i % 2 === 0 ? 'Dedi Kurniawan' : 'Bayu Saputra',
      scheduledAt: addDays(NOW, scheduled ? 2 + i : -1),
      status: scheduled ? 'scheduled' : 'in_progress',
      ticketId: null,
      scannedOnuSerial: null,
      measuredRxPower: null,
      photos: null,
      signatureUrl: null,
      gpsLat: null,
      gpsLng: null,
      completionNotes: null,
      completedAt: null,
      completedBy: null,
    });
  });

  historicalInstallCustomers.forEach((c, i) => {
    const scheduledAt = addDays(NOW, -60 - i * 3);
    const completedAt = addDays(scheduledAt, 0);
    rows.push({
      id: randomUUID(),
      type: 'install',
      customerId: c.id,
      customerName: c.fullName,
      technician: 'Dedi Kurniawan',
      scheduledAt,
      status: 'done',
      ticketId: null,
      scannedOnuSerial: c.onuSerial,
      measuredRxPower: c.onuSerial ? -20 - (i % 5) : null,
      photos: ['https://cdn.astaweda.com/wo/before.jpg', 'https://cdn.astaweda.com/wo/after.jpg'],
      signatureUrl: 'https://cdn.astaweda.com/signatures/wo-install.png',
      gpsLat: c.lat,
      gpsLng: c.lng,
      completionNotes: 'Instalasi ONU selesai, redaman optik dalam batas normal.',
      completedAt,
      completedBy: 'Dedi Kurniawan',
    });
  });

  return rows;
}

function buildRepairWorkOrders(ticketPool: TicketRow[]): WorkOrderRow[] {
  const picks = ticketPool.slice(0, 12);
  const statuses: Array<NewWorkOrder['status']> = [
    ...Array(8).fill('done'),
    ...Array(3).fill('in_progress'),
    ...Array(1).fill('cancelled'),
  ];
  return picks.map((ticket, i) => {
    const status = statuses[i] ?? 'scheduled';
    const scheduledAt = addDays(NOW, status === 'done' ? -3 - i : 1 + i);
    const isDone = status === 'done';
    return {
      id: randomUUID(),
      type: 'repair',
      customerId: ticket.customerId,
      customerName: ticket.customerName,
      technician: i % 3 === 0 ? 'Dedi Kurniawan' : 'Bayu Saputra',
      scheduledAt,
      status,
      ticketId: ticket.id,
      scannedOnuSerial: isDone ? `ZTEG${30_000_000 + i}` : null,
      measuredRxPower: isDone ? -21 - (i % 6) : null,
      photos: isDone ? ['https://cdn.astaweda.com/wo/repair.jpg'] : null,
      signatureUrl: isDone ? 'https://cdn.astaweda.com/signatures/wo-repair.png' : null,
      gpsLat: null,
      gpsLng: null,
      completionNotes: isDone ? 'Perbaikan redaman/penggantian patch-cord selesai.' : null,
      completedAt: isDone ? addDays(scheduledAt, 0) : null,
      completedBy: isDone ? 'Dedi Kurniawan' : null,
    };
  });
}

function buildDismantleWorkOrders(berhentiCustomers: SeededCustomer[]): WorkOrderRow[] {
  return berhentiCustomers.map((c, i) => {
    const scheduledAt = addDays(NOW, -10 - i * 2);
    return {
      id: randomUUID(),
      type: 'dismantle',
      customerId: c.id,
      customerName: c.fullName,
      technician: 'Bayu Saputra',
      scheduledAt,
      status: 'done',
      ticketId: null,
      scannedOnuSerial: c.onuSerial,
      measuredRxPower: null,
      photos: null,
      signatureUrl: null,
      gpsLat: c.lat,
      gpsLng: c.lng,
      completionNotes: 'Pencabutan ONU, unit dikembalikan ke gudang.',
      completedAt: addDays(scheduledAt, 0),
      completedBy: 'Bayu Saputra',
    };
  });
}

// ---------------------------------------------------------------------------
// Leads (sales pipeline) — a couple `won` leads narratively line up with the
// `instalasi` customers above (same name/address), no hard FK by design.
// ---------------------------------------------------------------------------

function buildLeads(
  resellers: Array<{ id: string }>,
  instalasiCustomers: SeededCustomer[],
): NewLead[] {
  const stageBlocks: Array<{ stage: NewLead['stage']; count: number }> = [
    { stage: 'new', count: 4 },
    { stage: 'survey', count: 4 },
    { stage: 'quote', count: 4 },
    { stage: 'won', count: 3 },
    { stage: 'lost', count: 3 },
  ];
  const sources: Array<NewLead['source']> = ['walk_in', 'referral', 'online', 'reseller'];
  const planNames = [
    'Paket Home 20 Mbps',
    'Paket Home 30 Mbps',
    'Paket Home 50 Mbps',
    'Paket Home 100 Mbps',
  ];
  const estValues = [149_000, 199_000, 299_000, 499_000];

  const leads: NewLead[] = [];
  let cursor = 0;
  for (const block of stageBlocks) {
    for (let n = 0; n < block.count; n += 1) {
      const i = cursor;
      cursor += 1;
      const source = sources[i % sources.length] ?? 'walk_in';
      // The first 3 `won` leads intentionally mirror the first 3 `instalasi`
      // customers (name/phone/address) — the visible lead -> onboarding link.
      const linked = block.stage === 'won' ? instalasiCustomers[n] : undefined;
      const area = areaFor(i + 400);
      leads.push({
        name: linked?.fullName ?? fullNameFor(i + 400),
        phone: linked?.phone ?? phoneFor(i + 400),
        address: linked?.address ?? addressFor(i + 400, area),
        areaName: linked?.areaCity ?? area.city,
        planName: planNames[i % planNames.length] ?? planNames[0],
        stage: block.stage,
        estValue: estValues[i % estValues.length] ?? 149_000,
        source,
        note: block.stage === 'lost' ? 'Batal — memilih provider lain.' : null,
        resellerId: source === 'reseller' ? (resellers[i % resellers.length]?.id ?? null) : null,
      });
    }
  }
  return leads;
}

// ---------------------------------------------------------------------------
// Inventory (warehouse + deployed ONUs) + stock-movement ledger.
// ---------------------------------------------------------------------------

interface InventoryRow extends NewInventoryItem {
  id: string;
}

function buildInventory(gponCustomers: SeededCustomer[]): {
  items: InventoryRow[];
  churnedItemCustomerId: Map<string, string>;
} {
  const items: InventoryRow[] = [];
  // A churned customer's ONU is nulled out of `assignedCustomerId` (it went
  // back to the warehouse) — this side map is the only remaining link from
  // the item to the customer it was dismantled from, for stock_movements.
  const churnedItemCustomerId = new Map<string, string>();

  for (const c of gponCustomers) {
    const isChurned = c.archetype === 'berhenti';
    const id = randomUUID();
    items.push({
      id,
      kind: 'onu',
      serial: c.onuSerial ?? `ZTEG${90_000_000 + c.index}`,
      status: isChurned ? 'warehouse' : 'installed',
      assignedTo: isChurned ? null : c.fullName,
      assignedCustomerId: isChurned ? null : c.id,
    });
    if (isChurned) churnedItemCustomerId.set(id, c.id);
  }

  // Warehouse-only stock, never assigned to a customer.
  for (let i = 0; i < 15; i += 1) {
    items.push({
      id: randomUUID(),
      kind: 'onu',
      serial: `WH-ONU-${String(i + 1).padStart(3, '0')}`,
      status: 'warehouse',
      assignedTo: null,
      assignedCustomerId: null,
    });
  }
  for (let i = 0; i < 8; i += 1) {
    items.push({
      id: randomUUID(),
      kind: 'router',
      serial: `WH-RTR-${String(i + 1).padStart(3, '0')}`,
      status: 'warehouse',
      assignedTo: null,
      assignedCustomerId: null,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    items.push({
      id: randomUUID(),
      kind: 'mikrotik',
      serial: `WH-MKT-${String(i + 1).padStart(3, '0')}`,
      status: 'warehouse',
      assignedTo: null,
      assignedCustomerId: null,
    });
  }
  // A handful of the warehouse-only ONUs turn out broken.
  for (let i = 0; i < 5; i += 1) {
    const item = items[gponCustomers.length + i];
    if (item) item.status = 'broken';
  }

  return { items, churnedItemCustomerId };
}

function buildStockMovements(
  items: InventoryRow[],
  churnedItemCustomerId: Map<string, string>,
  installWoByCustomer: Map<string, string>,
  dismantleWoByCustomer: Map<string, string>,
): NewStockMovement[] {
  const movements: NewStockMovement[] = [];
  items.forEach((item, i) => {
    const receivedAt = addDays(NOW, -90 - (i % 30));
    movements.push({
      itemId: item.id,
      serial: item.serial,
      kind: item.kind,
      type: 'in',
      note: 'Barang masuk gudang dari distributor.',
      workOrderId: null,
      at: receivedAt,
    });

    const churnedCustomerId = churnedItemCustomerId.get(item.id);
    if (item.assignedCustomerId) {
      movements.push({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'assign',
        note: `Dipasang untuk pelanggan ${item.assignedTo ?? ''}`.trim(),
        workOrderId: installWoByCustomer.get(item.assignedCustomerId) ?? null,
        at: addDays(receivedAt, 5),
      });
    } else if (churnedCustomerId) {
      // Churned customer: historical assign, then a return once dismantled.
      movements.push({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'assign',
        note: 'Dipasang untuk pelanggan (riwayat, sudah berhenti).',
        workOrderId: installWoByCustomer.get(churnedCustomerId) ?? null,
        at: addDays(receivedAt, 5),
      });
      movements.push({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'return',
        note: 'Dicabut setelah pelanggan berhenti berlangganan.',
        workOrderId: dismantleWoByCustomer.get(churnedCustomerId) ?? null,
        at: addDays(NOW, -8),
      });
    } else if (item.status === 'broken') {
      movements.push({
        itemId: item.id,
        serial: item.serial,
        kind: item.kind,
        type: 'broken',
        note: 'Unit rusak, dikarantina menunggu RMA.',
        workOrderId: null,
        at: addDays(receivedAt, 10),
      });
    }
  });
  return movements;
}

// ---------------------------------------------------------------------------
// Vouchers (hotspot loket sales).
// ---------------------------------------------------------------------------

function buildVouchers(
  activeResellers: Array<{ id: string }>,
  upsellCustomers: SeededCustomer[],
): NewVoucher[] {
  const tiers: Array<{ profile: string; price: number; days: number }> = [
    { profile: 'Hotspot 1 Hari', price: 5_000, days: 1 },
    { profile: 'Hotspot 3 Hari', price: 12_000, days: 3 },
    { profile: 'Hotspot 7 Hari', price: 25_000, days: 7 },
  ];
  const statuses: Array<NewVoucher['status']> = [
    ...Array(20).fill('unused'),
    ...Array(15).fill('used'),
    ...Array(5).fill('expired'),
  ];

  return statuses.map((status, i) => {
    const tier = tiers[i % tiers.length] ?? tiers[0];
    const batchId = `BATCH-${String(1000 + Math.floor(i / 10)).padStart(8, '0')}`;
    const code = `ASH-${String(1000 + i).padStart(4, '0')}-${String(2000 + i).padStart(4, '0')}`;
    const resellerId =
      i % 2 === 0 ? (activeResellers[i % activeResellers.length]?.id ?? null) : null;
    const isRedeemedByCustomer = status === 'used' && i % 4 === 0;
    const redeemedCustomer = isRedeemedByCustomer
      ? upsellCustomers[i % upsellCustomers.length]
      : undefined;
    return {
      code,
      batchId,
      profile: tier.profile,
      priceIdr: tier.price,
      durationDays: tier.days,
      status,
      usedAt: status === 'unused' ? null : addDays(NOW, -(i % 60) - 1),
      usedBy:
        status === 'unused' ? null : (redeemedCustomer?.fullName ?? `Hotspot User ${1000 + i}`),
      redeemedCustomerId: redeemedCustomer?.id ?? null,
      resellerId,
    };
  });
}

// ---------------------------------------------------------------------------
// PPPoE (per router) — profiles already built; secrets follow the billed
// customer base, throttled to the isolir profile for suspended accounts.
// ---------------------------------------------------------------------------

function buildPppSecrets(
  customers: SeededCustomer[],
  routers: Array<{ id: string; city: string }>,
  profilesByRouterAndTier: Map<string, Map<string, { id: string; name: string }>>,
  customerNoByCustomerId: Map<string, string>,
): NewPppSecret[] {
  const cityToRouter = new Map(routers.map((r) => [r.city, r]));
  return customers
    .filter(
      (c) => c.archetype !== 'prospek' && c.archetype !== 'instalasi' && c.archetype !== 'berhenti',
    )
    .map((c) => {
      const city = c.areaCity.includes('Bandung')
        ? 'Bandung'
        : c.areaCity.includes('Surabaya')
          ? 'Surabaya'
          : 'Jakarta';
      const router = cityToRouter.get(city) ?? routers[0];
      const tierKey = c.planName
        .replace('Paket ', '')
        .replace(' (Legacy)', '')
        .replace(/ Mbps$/, '');
      const isIsolir = c.archetype === 'isolir';
      const profiles = router ? profilesByRouterAndTier.get(router.id) : undefined;
      const profile = isIsolir
        ? profiles?.get('isolir')
        : (profiles?.get(tierKey) ?? profiles?.get('Home 20'));
      const customerNo = customerNoByCustomerId.get(c.id) ?? 'CUST-0000';
      return {
        routerId: router?.id ?? routers[0]?.id ?? '',
        username: pppoeUsernameFor(customerNo),
        profileId: profile?.id ?? '',
        profileName: profile?.name ?? 'Home 20',
        customerId: c.id,
        customerName: c.fullName,
        disabled: isIsolir,
        comment: isIsolir ? 'Diisolir otomatis — tunggakan' : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Reseller ledger + payouts.
// ---------------------------------------------------------------------------

function buildResellerLedgerAndPayouts(
  resellerSpecs: Array<{ id: string; commissionPct: number; status: 'active' | 'inactive' }>,
  invoicesByReseller: Map<string, InvoiceRow[]>,
): {
  ledger: NewResellerLedgerEntry[];
  payouts: NewResellerPayout[];
  finalBalances: Map<string, number>;
} {
  const ledger: NewResellerLedgerEntry[] = [];
  const payouts: NewResellerPayout[] = [];
  const finalBalances = new Map<string, number>();
  const payoutStatuses: Array<NewResellerPayout['status']> = [
    'paid',
    'requested',
    'approved',
    'rejected',
  ];

  resellerSpecs.forEach((reseller, i) => {
    let balance = 0;
    const topup = 5_000_000;
    balance += topup;
    ledger.push({
      resellerId: reseller.id,
      type: 'topup',
      amount: topup,
      note: 'Top-up saldo awal mitra.',
      balanceAfter: balance,
      ref: null,
      at: addDays(NOW, -60),
    });

    const paidInvoices = (invoicesByReseller.get(reseller.id) ?? []).slice(0, 4);
    paidInvoices.forEach((inv, k) => {
      const commission = Math.round(inv.amount * reseller.commissionPct);
      balance += commission;
      ledger.push({
        resellerId: reseller.id,
        type: 'commission',
        amount: commission,
        note: `Komisi pembayaran tagihan ${inv.customerName}.`,
        balanceAfter: balance,
        ref: inv.id,
        at: addDays(NOW, -30 + k * 5),
      });
    });

    const deduction = 100_000;
    balance -= deduction;
    ledger.push({
      resellerId: reseller.id,
      type: 'deduction',
      amount: -deduction,
      note: 'Penyesuaian saldo (koreksi admin).',
      balanceAfter: balance,
      ref: null,
      at: addDays(NOW, -10),
    });

    const payoutStatus = payoutStatuses[i % payoutStatuses.length] ?? 'requested';
    const payoutAmount = Math.min(500_000, Math.max(balance, 100_000));
    if (payoutStatus === 'paid') {
      balance -= payoutAmount;
      const withdrawalEntry: NewResellerLedgerEntry & { id: string } = {
        id: randomUUID(),
        resellerId: reseller.id,
        type: 'withdrawal',
        amount: -payoutAmount,
        note: 'Pencairan payout mitra.',
        balanceAfter: balance,
        ref: null,
        at: addDays(NOW, -3),
      };
      ledger.push(withdrawalEntry);
      payouts.push({
        resellerId: reseller.id,
        amount: payoutAmount,
        status: 'paid',
        note: 'Payout bulanan.',
        requestedBy: null,
        decidedBy: null,
        ledgerEntryId: withdrawalEntry.id,
        decidedAt: addDays(NOW, -4),
      });
    } else {
      payouts.push({
        resellerId: reseller.id,
        amount: payoutAmount,
        status: payoutStatus,
        note: 'Payout bulanan.',
        requestedBy: null,
        decidedBy: null,
        ledgerEntryId: null,
        decidedAt: payoutStatus === 'requested' ? null : addDays(NOW, -2),
      });
    }

    finalBalances.set(reseller.id, balance);
  });

  return { ledger, payouts, finalBalances };
}

// ---------------------------------------------------------------------------
// Customer archetype -> lifecycle status/hold-reason + a standalone
// outstanding-balance projection (pure function of the archetype + plan
// price, so it can be computed before the customer row — and therefore its
// real id — exists).
// ---------------------------------------------------------------------------

function statusFor(archetype: CustomerArchetype): {
  status: NewCustomer['status'];
  holdReason: NewCustomer['holdReason'];
} {
  switch (archetype) {
    case 'prospek':
      return { status: 'prospek', holdReason: null };
    case 'instalasi':
      return { status: 'instalasi', holdReason: null };
    case 'isolir':
      return { status: 'isolir', holdReason: 'overdue' };
    case 'berhenti':
      return { status: 'berhenti', holdReason: null };
    default:
      return { status: 'aktif', holdReason: null };
  }
}

function projectedOutstanding(archetype: CustomerArchetype, planPrice: number): number {
  const placeholderPlan: CustomerPlan = {
    index: 0,
    archetype,
    fullName: '',
    area: JAKARTA_AREAS[0],
    cityIndex: 0,
    planId: '',
    planPriceMonthly: planPrice,
    resellerId: null,
    odpId: null,
    connectionType: null,
    isProvisioned: false,
    rxPower: null,
  };
  return buildBilling(placeholderPlan, 'placeholder').outstanding;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.SEED_WIPE !== 'true') {
    console.log('SEED_WIPE is not "true" — skipping the demo seed (safe no-op).');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  const db = drizzle(pool, { schema });

  try {
    console.log('SEED_WIPE=true — wiping and repopulating the demo dataset...');

    // --- Wipe ------------------------------------------------------------
    await pool.query(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const seq of SEQUENCES_TO_RESTART) {
      await pool.query(`ALTER SEQUENCE ${seq.name} RESTART WITH ${seq.startWith}`);
    }

    // --- Dimension tables --------------------------------------------------
    const resellerRows = await db.insert(schema.resellers).values(RESELLER_SPECS).returning();
    await db.insert(schema.branches).values(BRANCH_SPECS);
    const planRows = await db.insert(schema.plans).values(PLAN_SPECS).returning();
    const odpRows = await db.insert(schema.odpRecords).values(buildOdpSpecs()).returning();

    const mitraReseller = resellerRows[MITRA_RESELLER_INDEX];
    if (!mitraReseller) throw new Error('mitra reseller missing after insert');
    const userSpecs = buildUserSpecs(mitraReseller.id);
    const passwordHash = await argon2.hash(DEMO_PASSWORD, ARGON2_OPTIONS);
    await db.insert(schema.users).values(userSpecs.map((u) => ({ ...u, passwordHash })));
    const userIdByEmail = new Map(userSpecs.map((u) => [u.email, u.id]));

    // --- Customers -----------------------------------------------------
    const customerPlans = buildCustomerPlans(planRows, resellerRows, odpRows);
    const planNameById = new Map(planRows.map((p) => [p.id, p.name]));

    const newCustomers: NewCustomer[] = customerPlans.map((cp) => {
      const { status, holdReason } = statusFor(cp.archetype);
      const linkedEmail = CUSTOMER_LOGIN_LINKS[cp.index];
      const address = addressFor(cp.index, cp.area);
      const { lat, lng } = latLngFor(cp.index);
      const outstanding = projectedOutstanding(cp.archetype, cp.planPriceMonthly);
      return {
        fullName: cp.fullName,
        phone: phoneFor(cp.index),
        email:
          cp.index % 4 === 0
            ? null
            : `${cp.fullName.toLowerCase().replace(/\s+/g, '.')}${cp.index}@gmail.com`,
        userId: linkedEmail ? (userIdByEmail.get(linkedEmail) ?? null) : null,
        address,
        areaId: null,
        areaName: cp.area.city,
        lat,
        lng,
        odpId: cp.odpId,
        planId: cp.planId,
        status,
        holdReason,
        outstanding,
        billingAnchorDay: cp.index % 20 === 0 ? (cp.index % 28) + 1 : null,
        npwp:
          cp.index % 15 === 0
            ? `01.234.567.${String(8 + (cp.index % 2))}-90${cp.index % 10}.000`
            : null,
        ktp: ktpFor(cp.index),
        consentAt: addDays(NOW, -(30 + ((cp.index * 37) % 480))),
        dataDeletionRequestedAt: null,
        resellerId: cp.resellerId,
        connection: null, // patched below, once customerNo is known.
        createdAt: addDays(NOW, -(30 + ((cp.index * 37) % 480))),
      };
    });

    const insertedCustomers: Customer[] = [];
    for (const batch of chunk(newCustomers, 25)) {
      const rows = await db.insert(schema.customers).values(batch).returning();
      insertedCustomers.push(...rows);
    }

    // Patch `connection` for every provisioned customer now that customerNo
    // is known (the PPPoE username/IP/ONU serial are all derived from it).
    const seededCustomers: SeededCustomer[] = [];
    const gponCustomers: SeededCustomer[] = [];
    for (let i = 0; i < customerPlans.length; i += 1) {
      const cp = customerPlans[i];
      const row = insertedCustomers[i];
      if (!cp || !row) continue;
      const planName = planNameById.get(cp.planId) ?? 'Paket Home 20 Mbps';
      const seeded: SeededCustomer = {
        id: row.id,
        index: cp.index,
        archetype: cp.archetype,
        fullName: cp.fullName,
        phone: row.phone,
        address: row.address,
        areaCity: cp.area.city,
        planId: cp.planId,
        planName,
        resellerId: cp.resellerId,
        lat: row.lat ?? 0,
        lng: row.lng ?? 0,
        onuSerial: null,
      };

      if (cp.isProvisioned && cp.connectionType) {
        const n = Number(row.customerNo.replace(/\D/g, '')) || 0;
        const onuSerial = cp.connectionType === 'gpon' ? `ZTEG${20_000_000 + (n % 100_000)}` : null;
        seeded.onuSerial = onuSerial;
        const connection: CustomerConnection = {
          type: cp.connectionType,
          pppoeUsername: pppoeUsernameFor(row.customerNo),
          profile: planName,
          ipAddress: `100.64.${100 + (n % 150)}.2`,
          onuSerial,
          olt: cp.connectionType === 'gpon' ? 'OLT-1' : null,
          ponPort: cp.connectionType === 'gpon' ? `0/${n % 8}/${n % 16}` : null,
          rxPower: cp.connectionType === 'gpon' ? cp.rxPower : null,
        };
        await db
          .update(schema.customers)
          .set({ connection })
          .where(eq(schema.customers.id, row.id));
        if (cp.connectionType === 'gpon') gponCustomers.push(seeded);
      }
      seededCustomers.push(seeded);
    }
    const customerNoByCustomerId = new Map(insertedCustomers.map((c) => [c.id, c.customerNo]));

    // --- Network: routers + PPPoE profiles/secrets + Mikrotik resources ---
    // Built ONCE into a local variable — every id below (router, profile)
    // comes from these same spec objects, never a fresh call, so nothing
    // can drift out of sync with what was actually inserted.
    const routerSpecs = buildRouterSpecs();
    await db.insert(schema.routers).values(routerSpecs.map(({ city, ...r }) => r));
    const routersForLookup = routerSpecs.map((r) => ({ id: r.id, city: r.city }));

    const pppProfileSpecs = buildPppProfileSpecs(routersForLookup);
    await db.insert(schema.pppProfiles).values(pppProfileSpecs.map(({ tier, ...p }) => p));
    const profilesByRouterAndTier = new Map<string, Map<string, { id: string; name: string }>>();
    for (const spec of pppProfileSpecs) {
      if (!profilesByRouterAndTier.has(spec.routerId))
        profilesByRouterAndTier.set(spec.routerId, new Map());
      profilesByRouterAndTier.get(spec.routerId)?.set(spec.tier, { id: spec.id, name: spec.name });
    }

    await db.insert(schema.simpleQueues).values(buildSimpleQueueSpecs(routersForLookup));
    await db.insert(schema.ipPools).values(buildIpPoolSpecs(routersForLookup));

    const pppSecretSpecs = buildPppSecrets(
      seededCustomers,
      routersForLookup,
      profilesByRouterAndTier,
      customerNoByCustomerId,
    );
    await db.insert(schema.pppSecrets).values(pppSecretSpecs);
    const secretCountByRouter = new Map<string, number>();
    for (const s of pppSecretSpecs) {
      secretCountByRouter.set(s.routerId, (secretCountByRouter.get(s.routerId) ?? 0) + 1);
    }
    for (const router of routerSpecs) {
      await db
        .update(schema.routers)
        .set({ secretCount: secretCountByRouter.get(router.id) ?? 0 })
        .where(eq(schema.routers.id, router.id));
    }

    // --- Billing: invoices + payments + payment intents ------------------
    const allInvoices: InvoiceRow[] = [];
    const allPayments: PaymentRow[] = [];
    const invoicesByCustomerId = new Map<string, InvoiceRow[]>();
    const slaCreditInvoiceByCustomer = new Map<string, string>();
    for (const c of seededCustomers) {
      // `seededCustomers` and `customerPlans` are both built in the same
      // 0..99 index order (see the construction loop above), so a direct
      // index lookup is exact — no `.find` needed.
      const cp = customerPlans[c.index];
      if (!cp) continue;
      const { invoices, payments, slaCreditInvoiceId } = buildBilling(cp, c.id);
      allInvoices.push(...invoices);
      allPayments.push(...payments);
      invoicesByCustomerId.set(c.id, invoices);
      if (slaCreditInvoiceId) slaCreditInvoiceByCustomer.set(c.id, slaCreditInvoiceId);
    }
    // One `adjustment`-type invoice demo, on the first aktif-good customer.
    const adjustmentCustomer = seededCustomers.find((c) => c.archetype === 'aktif-good');
    if (adjustmentCustomer) {
      const { invoice, payment } = buildAdjustmentInvoice(
        adjustmentCustomer.id,
        adjustmentCustomer.fullName,
      );
      allInvoices.push(invoice);
      allPayments.push(payment);
      invoicesByCustomerId.get(adjustmentCustomer.id)?.push(invoice);
    }

    const invoiceNoById = new Map<string, string>();
    for (const batch of chunk(allInvoices, 100)) {
      const rows = await db.insert(schema.invoices).values(batch).returning();
      for (const row of rows) invoiceNoById.set(row.id, row.invoiceNo);
    }
    const paymentsWithInvoiceNo = allPayments.map((p) => ({
      ...p,
      invoiceNo: invoiceNoById.get(p.invoiceId) ?? null,
    }));
    for (const batch of chunk(paymentsWithInvoiceNo, 100)) {
      await db.insert(schema.payments).values(batch);
    }

    // A handful of gateway payment intents on still-`pending` current
    // invoices, cycling every online payment channel + intent status.
    const pendingCurrentInvoices = allInvoices.filter(
      (inv) => inv.status === 'pending' && inv.type === 'regular',
    );
    const intentSpecs: NewPaymentIntent[] = pendingCurrentInvoices.slice(0, 9).map((inv, i) => {
      const channel = PAYMENT_CHANNELS[i % PAYMENT_CHANNELS.length] ?? 'qris';
      const status: NewPaymentIntent['status'] =
        (['pending', 'paid', 'expired'] as const)[i % 3] ?? 'pending';
      const isVa = channel.startsWith('va_');
      return {
        invoiceId: inv.id,
        invoiceNo: invoiceNoById.get(inv.id) ?? '',
        customerName: inv.customerName,
        amount: invoiceTotal(inv),
        channel,
        status,
        vaNumber: isVa ? `8${String(800_000_000_000 + i).padStart(12, '0')}` : null,
        qrPayload: isVa ? null : `https://pay.astaweda.com/qr/${inv.id}`,
        gatewayReference: status === 'pending' ? null : `TRX-${1_000_000 + i}`,
        expiresAt: addDays(NOW, status === 'expired' ? -1 : 1),
        paidAt: status === 'paid' ? addDays(NOW, -1) : null,
        createdAt: addDays(NOW, -2),
      };
    });
    if (intentSpecs.length > 0) await db.insert(schema.paymentIntents).values(intentSpecs);

    // --- Contracts (PKS) ---------------------------------------------------
    const contractSpecs = seededCustomers
      .filter((c) => c.archetype !== 'prospek')
      .map((c) => buildContract(c, c.archetype, c.planName));
    await db.insert(schema.contracts).values(contractSpecs);

    // --- Tickets + timeline events ------------------------------------
    const slaCreditCustomers = seededCustomers.filter((c) => c.archetype === 'aktif-slacredit');
    const generalTicketPool = seededCustomers.filter((c) => c.index >= 5);
    const ticketBuild = buildTickets(slaCreditCustomers, generalTicketPool);
    const ticketRows = await db.insert(schema.tickets).values(ticketBuild.tickets).returning();
    const ticketCodeById = new Map(ticketRows.map((t) => [t.id, t.code]));
    for (const batch of chunk(ticketBuild.events, 200)) {
      await db.insert(schema.ticketEvents).values(batch);
    }

    // --- SLA credits -----------------------------------------------------
    const slaCreditSpecs: NewSlaCredit[] = [];
    // 7 applied: exactly the discount already baked into each aktif-slacredit
    // customer's current invoice (see buildBilling's 'aktif-slacredit' arm).
    for (const { ticketId, customerId } of ticketBuild.slaCreditTickets) {
      const invoiceId = slaCreditInvoiceByCustomer.get(customerId);
      const customer = seededCustomers.find((c) => c.id === customerId);
      if (!invoiceId || !customer) continue;
      slaCreditSpecs.push({
        customerId,
        customerName: customer.fullName,
        amount: SLA_CREDIT_AMOUNT_IDR,
        reason: 'Gangguan koneksi berulang > 24 jam (kompensasi SLA)',
        ticketId,
        ticketCode: ticketCodeById.get(ticketId) ?? null,
        status: 'applied',
        appliedInvoiceId: invoiceId,
        appliedAt: addDays(NOW, -2),
      });
    }
    // 3 pending (not yet applied to any invoice) + 2 void (cancelled), drawn
    // from the generic breached/resolved tickets — covers every
    // sla_credit_status value.
    const extraCreditTickets = ticketBuild.tickets.filter(
      (t) =>
        t.status === 'breached' && !ticketBuild.slaCreditTickets.some((s) => s.ticketId === t.id),
    );
    extraCreditTickets.slice(0, 3).forEach((t, i) => {
      slaCreditSpecs.push({
        customerId: t.customerId,
        customerName: t.customerName,
        amount: [30_000, 40_000, 60_000][i] ?? 30_000,
        reason: 'Gangguan jaringan area — menunggu approval kompensasi',
        ticketId: t.id,
        ticketCode: ticketCodeById.get(t.id) ?? null,
        status: 'pending',
        appliedInvoiceId: null,
        appliedAt: null,
      });
    });
    const voidSourceTickets = ticketBuild.tickets
      .filter((t) => t.status === 'resolved')
      .slice(0, 2);
    voidSourceTickets.forEach((t, i) => {
      slaCreditSpecs.push({
        customerId: t.customerId,
        customerName: t.customerName,
        amount: [20_000, 25_000][i] ?? 20_000,
        reason: 'Klaim kompensasi dibatalkan — gangguan di luar SLA',
        ticketId: t.id,
        ticketCode: ticketCodeById.get(t.id) ?? null,
        status: 'void',
        appliedInvoiceId: null,
        appliedAt: null,
      });
    });
    await db.insert(schema.slaCredits).values(slaCreditSpecs);

    // --- Work orders -------------------------------------------------------
    const instalasiCustomers = seededCustomers.filter((c) => c.archetype === 'instalasi');
    const historicalInstallCustomers = seededCustomers
      .filter((c) => c.archetype === 'aktif-good')
      .slice(0, 7);
    const berhentiCustomers = seededCustomers.filter((c) => c.archetype === 'berhenti');

    const installWorkOrders = buildInstallWorkOrders(
      instalasiCustomers,
      historicalInstallCustomers,
    );
    const repairWorkOrders = buildRepairWorkOrders(ticketBuild.repairCandidates);
    const dismantleWorkOrders = buildDismantleWorkOrders(berhentiCustomers);
    const allWorkOrders = [...installWorkOrders, ...repairWorkOrders, ...dismantleWorkOrders];
    await db.insert(schema.workOrders).values(allWorkOrders);

    const installWoByCustomer = new Map<string, string>();
    for (const wo of installWorkOrders)
      if (wo.customerId) installWoByCustomer.set(wo.customerId, wo.id);
    const dismantleWoByCustomer = new Map<string, string>();
    for (const wo of dismantleWorkOrders)
      if (wo.customerId) dismantleWoByCustomer.set(wo.customerId, wo.id);

    // --- Leads (sales pipeline) --------------------------------------------
    await db.insert(schema.leads).values(buildLeads(resellerRows, instalasiCustomers));

    // --- Inventory + stock movements ---------------------------------------
    const { items: inventoryItems, churnedItemCustomerId } = buildInventory(gponCustomers);
    await db.insert(schema.inventoryItems).values(inventoryItems);
    const stockMovements = buildStockMovements(
      inventoryItems,
      churnedItemCustomerId,
      installWoByCustomer,
      dismantleWoByCustomer,
    );
    for (const batch of chunk(stockMovements, 200)) {
      await db.insert(schema.stockMovements).values(batch);
    }

    // --- Vouchers ------------------------------------------------------
    const activeResellers = resellerRows.filter((r) => r.status === 'active');
    const upsellCustomers = seededCustomers.filter((c) => c.archetype === 'aktif-good');
    await db.insert(schema.vouchers).values(buildVouchers(activeResellers, upsellCustomers));

    // --- Reseller ledger + payouts ------------------------------------------
    const invoicesByReseller = new Map<string, InvoiceRow[]>();
    for (const c of seededCustomers) {
      if (!c.resellerId) continue;
      const paid = (invoicesByCustomerId.get(c.id) ?? []).filter((inv) => inv.status === 'paid');
      const existing = invoicesByReseller.get(c.resellerId) ?? [];
      invoicesByReseller.set(c.resellerId, [...existing, ...paid]);
    }
    const { ledger, payouts, finalBalances } = buildResellerLedgerAndPayouts(
      resellerRows,
      invoicesByReseller,
    );
    await db.insert(schema.resellerLedger).values(ledger);
    await db.insert(schema.resellerPayouts).values(payouts);
    for (const [resellerId, balance] of finalBalances) {
      await db.update(schema.resellers).set({ balance }).where(eq(schema.resellers.id, resellerId));
    }

    // --- App settings (demo company identity, singleton) --------------------
    await db.insert(schema.appSettings).values({
      companyName: 'Astaweda Net',
      companyAddress: 'Jl. Kemang Raya No. 88, Jakarta Selatan',
      companyPhone: '021-29001234',
      companyEmail: 'billing@astaweda.com',
      billingLateFeeIdr: LATE_FEE_IDR,
      billingDueDays: 10,
      billingIsolirGraceDays: 3,
      taxPkp: true,
      taxNpwp: '01.234.567.8-901.000',
      taxPpnRate: PPN_RATE,
    });

    // --- Summary -------------------------------------------------------
    console.log('\nDemo seed complete. Row counts:');
    for (const table of ALL_TABLES) {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table}`);
      console.log(`  ${table.padEnd(24)} ${rows[0]?.n ?? '0'}`);
    }
    console.log('\nDemo logins (all share the password below):');
    for (const u of userSpecs) {
      console.log(`  ${(u.role ?? 'customer').padEnd(9)} ${u.email}`);
    }
    console.log(`  password: ${DEMO_PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Demo seed failed:', err);
  process.exitCode = 1;
});
