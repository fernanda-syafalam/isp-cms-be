import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, inArray, or } from 'drizzle-orm';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type CableRow,
  type CircuitRow,
  type ClosureRow,
  type LatLng,
  type NetworkNodeRow,
  type NodeMeta,
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
import type { UpdateNodeInput } from './dto/create-node.dto';
import { type DropPlan, clearPortsFor, planDrop, planSplitterRatio } from './topology.allocator';
import { deriveCabling } from './topology.derive';
import { buildTopologyFixture } from './topology.fixtures';
import { indexById, oltOf, routeLength, segmentMeters, servingOdp } from './topology.graph';

// The transaction handle drizzle hands its callback — used to type the private
// write helpers without an `any`.
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

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

  // ---- Single-row reads (used by the mutation service for 404 mapping) -------

  async findNode(id: string): Promise<NetworkNodeRow | undefined> {
    const [row] = await this.db.select().from(networkNodes).where(eq(networkNodes.id, id)).limit(1);
    return row;
  }

  async findCable(id: string): Promise<CableRow | undefined> {
    const [row] = await this.db.select().from(cables).where(eq(cables.id, id)).limit(1);
    return row;
  }

  // ---- Write surface (node form + customer-drop install) --------------------

  /** Create an infra node; provision its splitter when it is an ODC/ODP. */
  async createNode(input: {
    name: string;
    type: NetworkNodeRow['type'];
    status: NetworkNodeRow['status'];
    parentId: string | null;
    lat: number;
    lng: number;
    meta: NodeMeta | null;
    splitterRatio: SplitterRow['ratio'] | null;
  }): Promise<NetworkNodeRow> {
    return this.db.transaction(async (tx) => {
      const [node] = await tx
        .insert(networkNodes)
        .values({
          id: randomUUID(),
          name: input.name,
          type: input.type,
          status: input.status,
          parentId: input.parentId,
          lat: input.lat,
          lng: input.lng,
          meta: input.meta ?? null,
        })
        .returning();
      if (!node) throw new Error('failed to create node');
      if ((input.type === 'odc' || input.type === 'odp') && input.splitterRatio) {
        const plan = planSplitterRatio(undefined, node.id, input.splitterRatio);
        if (plan) await tx.insert(splitters).values(plan).onConflictDoNothing();
      }
      return node;
    });
  }

  /**
   * Patch a node's fields/meta. A customer whose uplink moved to a different
   * serving ODP is re-homed atomically (old drop freed, new one allocated) so
   * capacity on both ODPs stays honest; a full target throws 409. A dragged node
   * has its drop-cable geometry re-synced. Throws 404 when the node is gone.
   */
  async updateNode(
    id: string,
    body: UpdateNodeInput,
    conn: { ponPort?: string | null; onuSerial?: string | null } | null,
  ): Promise<NetworkNodeRow> {
    return this.db.transaction(async (tx) => {
      const [found] = await tx.select().from(networkNodes).where(eq(networkNodes.id, id)).limit(1);
      if (!found) throw new NotFoundException('Node tidak ditemukan');

      const moved = body.lat !== undefined || body.lng !== undefined;
      const parentChanged = body.parentId !== undefined && body.parentId !== found.parentId;

      let rehomedCore: number | undefined;
      const customerId = found.type === 'customer' ? found.meta?.customerId : undefined;
      if (customerId && parentChanged) {
        rehomedCore = await this.rehomeDrop(tx, found, body, customerId, conn ?? {});
      }

      const effectiveType = body.type ?? found.type;
      const updates: Partial<typeof networkNodes.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.type !== undefined) updates.type = body.type;
      if (body.status !== undefined) updates.status = body.status;
      if (body.parentId !== undefined) updates.parentId = body.parentId;
      if (body.lat !== undefined) updates.lat = body.lat;
      if (body.lng !== undefined) updates.lng = body.lng;

      const metaChanged =
        body.ipAddress !== undefined ||
        body.model !== undefined ||
        body.maintenance !== undefined ||
        rehomedCore !== undefined;
      if (metaChanged) {
        updates.meta = {
          ...found.meta,
          ...(body.ipAddress !== undefined ? { ipAddress: body.ipAddress } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.maintenance !== undefined ? { maintenance: body.maintenance } : {}),
          ...(rehomedCore !== undefined ? { coreNo: rehomedCore } : {}),
        };
      }
      await tx.update(networkNodes).set(updates).where(eq(networkNodes.id, id));

      if (body.splitterRatio && (effectiveType === 'odc' || effectiveType === 'odp')) {
        const [existing] = await tx
          .select()
          .from(splitters)
          .where(eq(splitters.nodeId, id))
          .limit(1);
        const plan = planSplitterRatio(existing, id, body.splitterRatio);
        if (plan) {
          await tx
            .insert(splitters)
            .values(plan)
            .onConflictDoUpdate({
              target: splitters.id,
              set: { ratio: plan.ratio, ports: plan.ports },
            });
        }
      }

      if (moved) await this.resyncGeometry(tx, id);

      const [updated] = await tx
        .select()
        .from(networkNodes)
        .where(eq(networkNodes.id, id))
        .limit(1);
      if (!updated) throw new NotFoundException('Node tidak ditemukan');
      return updated;
    });
  }

  /** Delete a node, cascade-freeing its cabling and reparenting its children. */
  async deleteNode(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [removed] = await tx
        .select()
        .from(networkNodes)
        .where(eq(networkNodes.id, id))
        .limit(1);
      if (!removed) return false;
      const customerId = removed.type === 'customer' ? removed.meta?.customerId : undefined;
      if (customerId) await this.freeCustomerDrop(tx, customerId, removed.id);
      if (removed.type === 'odc' || removed.type === 'odp') {
        await tx.delete(splitters).where(eq(splitters.nodeId, removed.id));
        await tx.delete(closures).where(eq(closures.nodeId, removed.id));
      }
      await tx
        .update(networkNodes)
        .set({ parentId: removed.parentId })
        .where(eq(networkNodes.parentId, removed.id));
      await tx.delete(networkNodes).where(eq(networkNodes.id, removed.id));
      return true;
    });
  }

  /** Replace a cable's surveyed route and recompute its length. */
  async updateCableRoute(id: string, route: LatLng[]): Promise<CableRow | undefined> {
    const [cable] = await this.db.select().from(cables).where(eq(cables.id, id)).limit(1);
    if (!cable) return undefined;
    const [updated] = await this.db
      .update(cables)
      .set({ route, lengthM: routeLength(route) })
      .where(eq(cables.id, id))
      .returning();
    return updated;
  }

  /**
   * Install a provisioned subscriber's drop onto a target ODP atomically:
   * allocate a free splitter port + drop cable + strand + circuit, then create
   * the customer node. Throws the precise Bahasa error per failure (already
   * installed / ODP or port missing / port taken / splitter full).
   */
  async customerDrop(input: {
    customerId: string;
    customerNodeId: string;
    odpId: string;
    name: string;
    netStatus: NetworkNodeRow['status'];
    lat: number;
    lng: number;
    portNo?: number | undefined;
    metaBase: NodeMeta;
    conn: { ponPort?: string | null; onuSerial?: string | null };
  }): Promise<NetworkNodeRow> {
    return this.db.transaction(async (tx) => {
      const [exists] = await tx
        .select()
        .from(networkNodes)
        .where(eq(networkNodes.id, input.customerNodeId))
        .limit(1);
      if (exists) throw new ConflictException('Pelanggan sudah terpasang di peta');

      const [odp] = await tx
        .select()
        .from(networkNodes)
        .where(and(eq(networkNodes.id, input.odpId), eq(networkNodes.type, 'odp')))
        .limit(1);
      if (!odp) throw new NotFoundException('ODP tidak ditemukan');

      const [splitter] = await tx
        .select()
        .from(splitters)
        .where(eq(splitters.nodeId, input.odpId))
        .limit(1);
      if (input.portNo != null) {
        const port = splitter?.ports.find((p) => p.portNo === input.portNo);
        if (!port) throw new NotFoundException(`Port #${input.portNo} tidak ada di ODP ini.`);
        if (port.outNodeId !== null)
          throw new ConflictException(`Port #${input.portNo} sudah terpakai. Pilih port lain.`);
      }
      if (!splitter) throw new ConflictException('Port splitter penuh. Pilih ODP lain.');

      const allNodes = await tx.select().from(networkNodes);
      const oltNodeId = oltOf(odp, indexById(allNodes))?.id ?? odp.id;
      const plan = planDrop({
        splitter,
        odp: { id: odp.id, lat: odp.lat, lng: odp.lng },
        oltNodeId,
        customerId: input.customerId,
        customerNodeId: input.customerNodeId,
        customerPoint: { lat: input.lat, lng: input.lng },
        conn: input.conn,
        portNo: input.portNo,
      });
      if (!plan) throw new ConflictException('Port splitter penuh. Pilih ODP lain.');

      await this.writeDrop(tx, plan, splitter.nodeId);
      const [node] = await tx
        .insert(networkNodes)
        .values({
          id: input.customerNodeId,
          name: input.name,
          type: 'customer',
          status: input.netStatus,
          parentId: odp.id,
          lat: input.lat,
          lng: input.lng,
          meta: { ...input.metaBase, coreNo: plan.coreNo },
        })
        .returning();
      if (!node) throw new Error('failed to create customer node');
      return node;
    });
  }

  // ---- Private write helpers -----------------------------------------------

  /**
   * Re-home a customer's drop to its new serving ODP (mirrors the FE
   * rehomeCustomerDrop's validate-on-a-shadow-first contract). Returns the new
   * core, or undefined when nothing actually moved / there is no ODP ancestor.
   * Throws 409 when the target ODP is full.
   */
  private async rehomeDrop(
    tx: DbTx,
    found: NetworkNodeRow,
    body: UpdateNodeInput,
    customerId: string,
    conn: { ponPort?: string | null; onuSerial?: string | null },
  ): Promise<number | undefined> {
    const allNodes = await tx.select().from(networkNodes);
    const byId = indexById(allNodes);
    const shadow: NetworkNodeRow = {
      ...found,
      parentId: body.parentId ?? found.parentId,
      lat: body.lat ?? found.lat,
      lng: body.lng ?? found.lng,
    };
    byId.set(found.id, shadow);
    const newOdp = servingOdp(shadow, byId);
    if (!newOdp) return undefined; // no ODP ancestor — leave the drop where it is

    const allSplitters = await tx.select().from(splitters);
    const bound = allSplitters.find((s) => s.ports.some((p) => p.customerId === customerId));
    if (bound?.nodeId === newOdp.id) return undefined; // already homed on this ODP

    const target = allSplitters.find((s) => s.nodeId === newOdp.id);
    if (!target || !target.ports.some((p) => p.outNodeId === null)) {
      throw new ConflictException('Port splitter penuh di ODP tujuan. Pilih ODP lain.');
    }

    await this.freeCustomerDrop(tx, customerId, found.id);
    const oltNodeId = oltOf(newOdp, byId)?.id ?? newOdp.id;
    const plan = planDrop({
      splitter: target,
      odp: { id: newOdp.id, lat: newOdp.lat, lng: newOdp.lng },
      oltNodeId,
      customerId,
      customerNodeId: found.id,
      customerPoint: { lat: shadow.lat, lng: shadow.lng },
      conn,
    });
    if (!plan) throw new ConflictException('Port splitter penuh di ODP tujuan. Pilih ODP lain.');
    await this.writeDrop(tx, plan, target.nodeId);
    return plan.coreNo;
  }

  /**
   * Free everything a customer's drop occupies (mirrors the FE freeDrop): clear
   * the splitter port(s), then delete the splice / strand / drop cable / circuit.
   */
  private async freeCustomerDrop(
    tx: DbTx,
    customerId: string,
    customerNodeId: string,
  ): Promise<void> {
    const allSplitters = await tx.select().from(splitters);
    for (const s of allSplitters) {
      if (s.ports.some((p) => p.customerId === customerId || p.outNodeId === customerNodeId)) {
        await tx
          .update(splitters)
          .set({ ports: clearPortsFor(s.ports, customerId, customerNodeId) })
          .where(eq(splitters.id, s.id));
      }
    }
    const custStrands = await tx.select().from(strands).where(eq(strands.customerId, customerId));
    const cableIds = custStrands.map((row) => row.cableId);
    if (cableIds.length > 0) await tx.delete(splices).where(inArray(splices.outCableId, cableIds));
    await tx.delete(strands).where(eq(strands.customerId, customerId));
    await tx.delete(cables).where(eq(cables.toNodeId, customerNodeId));
    await tx.delete(circuits).where(eq(circuits.customerId, customerId));
  }

  /** Persist an allocation: insert its rows and bind the chosen splitter port. */
  private async writeDrop(tx: DbTx, plan: DropPlan, splitterNodeId: string): Promise<void> {
    await tx.insert(cables).values(plan.cable);
    await tx.insert(strands).values(plan.strand);
    await tx.insert(splices).values(plan.splice);
    await tx.insert(circuits).values(plan.circuit);
    await tx
      .update(splitters)
      .set({ ports: plan.ports })
      .where(eq(splitters.nodeId, splitterNodeId));
  }

  /** Re-sync stored drop-cable geometry after a node moved (mirrors syncNodeGeometry). */
  private async resyncGeometry(tx: DbTx, nodeId: string): Promise<void> {
    const fresh = await tx.select().from(networkNodes);
    const byId = indexById(fresh);
    const touching = await tx
      .select()
      .from(cables)
      .where(or(eq(cables.fromNodeId, nodeId), eq(cables.toNodeId, nodeId)));
    for (const cable of touching) {
      const from = byId.get(cable.fromNodeId);
      const to = byId.get(cable.toNodeId);
      if (!from || !to) continue;
      await tx
        .update(cables)
        .set({
          route: [
            { lat: from.lat, lng: from.lng },
            { lat: to.lat, lng: to.lng },
          ],
          lengthM: segmentMeters(from, to),
        })
        .where(eq(cables.id, cable.id));
    }
  }
}
