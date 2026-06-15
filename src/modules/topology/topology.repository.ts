import { Injectable } from '@nestjs/common';
import { asc, count } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type CableRow,
  type CircuitRow,
  type ClosureRow,
  type NetworkNodeRow,
  type SpliceRow,
  type SplitterRow,
  type StrandRow,
  cables,
  circuits,
  closures,
  networkNodes,
  splices,
  splitters,
  strands,
} from '../../infrastructure/database/schema/topology.schema';
import { deriveCabling } from './topology.derive';
import { buildTopologyFixture } from './topology.fixtures';

/**
 * The only place that talks to the topology + OSP cabling tables
 * (network_nodes, cables, strands, splitters, closures, splices, circuits).
 * Returns domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class TopologyRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed the node forest + its derived cabling on first read. Idempotent: a
  // single guard on network_nodes (deterministic string ids) means a re-run is a
  // no-op, and onConflictDoNothing makes a concurrent double-seed safe.
  async ensureSeeded(): Promise<void> {
    const [existing] = await this.db.select({ value: count() }).from(networkNodes);
    if ((existing?.value ?? 0) > 0) return;

    const nodes = buildTopologyFixture();
    const cabling = deriveCabling(nodes);

    await this.db.insert(networkNodes).values(nodes).onConflictDoNothing();
    if (cabling.splitters.length)
      await this.db.insert(splitters).values(cabling.splitters).onConflictDoNothing();
    if (cabling.closures.length)
      await this.db.insert(closures).values(cabling.closures).onConflictDoNothing();
    if (cabling.cables.length)
      await this.db.insert(cables).values(cabling.cables).onConflictDoNothing();
    if (cabling.strands.length)
      await this.db.insert(strands).values(cabling.strands).onConflictDoNothing();
    if (cabling.splices.length)
      await this.db.insert(splices).values(cabling.splices).onConflictDoNothing();
    if (cabling.circuits.length)
      await this.db.insert(circuits).values(cabling.circuits).onConflictDoNothing();
  }

  listNodes(): Promise<NetworkNodeRow[]> {
    return this.db.select().from(networkNodes).orderBy(asc(networkNodes.id));
  }

  listCables(): Promise<CableRow[]> {
    return this.db.select().from(cables).orderBy(asc(cables.id));
  }

  listStrands(): Promise<StrandRow[]> {
    return this.db.select().from(strands).orderBy(asc(strands.id));
  }

  listSplitters(): Promise<SplitterRow[]> {
    return this.db.select().from(splitters).orderBy(asc(splitters.id));
  }

  listClosures(): Promise<ClosureRow[]> {
    return this.db.select().from(closures).orderBy(asc(closures.id));
  }

  listSplices(): Promise<SpliceRow[]> {
    return this.db.select().from(splices).orderBy(asc(splices.id));
  }

  listCircuits(): Promise<CircuitRow[]> {
    return this.db.select().from(circuits).orderBy(asc(circuits.id));
  }
}
