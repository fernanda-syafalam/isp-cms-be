import {
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

// Physical network topology + OSP cabling layer. The logical chain is
// OLT -> ODC -> ODP -> pole -> customer, expressed as a parentId link on each
// node; the cabling tables (cables/strands/splitters/closures/splices/circuits)
// add the physical facts the logical tree cannot carry. Node ids are STRINGS
// (e.g. 'olt-1', `${customerId}-node`), not generated uuids, so the
// customer<->topology deep-link round-trip is stable. A real backend hydrates
// these from an OSP/GIS system; here they are derived + seeded on first read.

export const nodeType = pgEnum('node_type', ['olt', 'odc', 'odp', 'pole', 'customer']);
// NETWORK/optical status (the map color) — distinct from billing lifecycle.
export const nodeStatus = pgEnum('node_status', ['up', 'down', 'unknown']);
export const cableKind = pgEnum('cable_kind', ['feeder', 'distribution', 'drop']);
export const cableStatus = pgEnum('cable_status', ['planned', 'installed', 'retired']);
export const strandStatus = pgEnum('strand_status', ['allocated', 'reserved', 'dead']);
export const splitterRatio = pgEnum('splitter_ratio', [
  '1:2',
  '1:4',
  '1:8',
  '1:16',
  '1:32',
  '1:64',
]);
export const closureType = pgEnum('closure_type', ['odc', 'odp', 'joint', 'inline']);
export const spliceType = pgEnum('splice_type', ['fusion', 'mechanical', 'passthrough']);
export const circuitStatus = pgEnum('circuit_status', ['active', 'planned', 'down']);

// A geographic waypoint along a cable route.
export type LatLng = { lat: number; lng: number };

// One output port of a PON splitter: bound to a downstream node (an ODP feeder
// or a customer drop) or free (null).
export type SplitterPort = {
  portNo: number;
  outNodeId: string | null;
  customerId: string | null;
  strandId: string | null;
};

// Type-specific node metadata (all optional; populated per node type). The
// splitter/portsUsed/portsTotal (ODC/ODP) and coreNo (customer) fields are a
// PROJECTION of the cabling layer, recomputed at read time — never the source of
// truth. The rest (model, ipAddress, customerId, planName, ...) pass through.
export type NodeMeta = {
  ipAddress?: string;
  model?: string;
  splitter?: string;
  portsUsed?: number;
  portsTotal?: number;
  rxPowerDbm?: number;
  uptimePct?: number;
  customerId?: string;
  planName?: string;
  coreNo?: number;
  onuSerial?: string;
  ponPort?: string;
  lifecycle?: 'prospek' | 'instalasi' | 'aktif' | 'isolir' | 'berhenti';
  maintenance?: boolean;
};

export const networkNodes = pgTable('network_nodes', {
  // String id (e.g. 'olt-1', 'olt-1-odc-1-odp-1', `${customerId}-node`).
  id: varchar('id', { length: 120 }).primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  type: nodeType('type').notNull(),
  status: nodeStatus('status').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  // Uplink node id; null at the OLT root.
  parentId: varchar('parent_id', { length: 120 }),
  meta: jsonb('meta').$type<NodeMeta>(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

export const cables = pgTable('cables', {
  id: varchar('id', { length: 120 }).primaryKey(),
  kind: cableKind('kind').notNull(),
  spec: varchar('spec', { length: 120 }).notNull(),
  fiberCount: integer('fiber_count').notNull(),
  tubeCount: integer('tube_count').notNull(),
  fromNodeId: varchar('from_node_id', { length: 120 }).notNull(),
  toNodeId: varchar('to_node_id', { length: 120 }).notNull(),
  // Surveyed waypoints; [] means a straight from->to run.
  route: jsonb('route').$type<LatLng[]>().notNull(),
  lengthM: doublePrecision('length_m').notNull(),
  status: cableStatus('status').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true, precision: 3 }),
});

export const strands = pgTable('strands', {
  id: varchar('id', { length: 120 }).primaryKey(),
  cableId: varchar('cable_id', { length: 120 }).notNull(),
  tubeNo: integer('tube_no').notNull(),
  coreNo: integer('core_no').notNull(),
  status: strandStatus('status').notNull(),
  circuitId: varchar('circuit_id', { length: 120 }),
  customerId: varchar('customer_id', { length: 120 }),
});

export const splitters = pgTable('splitters', {
  id: varchar('id', { length: 120 }).primaryKey(),
  nodeId: varchar('node_id', { length: 120 }).notNull(),
  ratio: splitterRatio('ratio').notNull(),
  inCableId: varchar('in_cable_id', { length: 120 }),
  inStrandId: varchar('in_strand_id', { length: 120 }),
  // length === ratioCount(ratio); occupancy drives the projected portsUsed.
  ports: jsonb('ports').$type<SplitterPort[]>().notNull(),
});

export const closures = pgTable('closures', {
  id: varchar('id', { length: 120 }).primaryKey(),
  type: closureType('type').notNull(),
  nodeId: varchar('node_id', { length: 120 }).notNull(),
  trayCapacity: integer('tray_capacity').notNull(),
  fiberCapacity: integer('fiber_capacity').notNull(),
});

export const splices = pgTable('splices', {
  id: varchar('id', { length: 120 }).primaryKey(),
  closureId: varchar('closure_id', { length: 120 }).notNull(),
  inCableId: varchar('in_cable_id', { length: 120 }).notNull(),
  inTubeNo: integer('in_tube_no').notNull(),
  inCoreNo: integer('in_core_no').notNull(),
  outCableId: varchar('out_cable_id', { length: 120 }).notNull(),
  outTubeNo: integer('out_tube_no').notNull(),
  outCoreNo: integer('out_core_no').notNull(),
  type: spliceType('type').notNull(),
  lossDb: doublePrecision('loss_db').notNull(),
});

export const circuits = pgTable('circuits', {
  id: varchar('id', { length: 120 }).primaryKey(),
  customerId: varchar('customer_id', { length: 120 }).notNull(),
  customerNodeId: varchar('customer_node_id', { length: 120 }).notNull(),
  oltNodeId: varchar('olt_node_id', { length: 120 }).notNull(),
  oltPonPort: varchar('olt_pon_port', { length: 40 }).notNull(),
  onuSerial: varchar('onu_serial', { length: 120 }),
  status: circuitStatus('status').notNull(),
});

// Domain types derived from the schema — never hand-written (Pilar 3).
export type NetworkNodeRow = typeof networkNodes.$inferSelect;
export type NewNetworkNode = typeof networkNodes.$inferInsert;
export type CableRow = typeof cables.$inferSelect;
export type NewCable = typeof cables.$inferInsert;
export type StrandRow = typeof strands.$inferSelect;
export type NewStrand = typeof strands.$inferInsert;
export type SplitterRow = typeof splitters.$inferSelect;
export type NewSplitter = typeof splitters.$inferInsert;
export type ClosureRow = typeof closures.$inferSelect;
export type NewClosure = typeof closures.$inferInsert;
export type SpliceRow = typeof splices.$inferSelect;
export type NewSplice = typeof splices.$inferInsert;
export type CircuitRow = typeof circuits.$inferSelect;
export type NewCircuit = typeof circuits.$inferInsert;
