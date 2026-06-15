import { Injectable, NotFoundException } from '@nestjs/common';
import type { NodeMeta } from '../../infrastructure/database/schema/topology.schema';
import type { CableResponse } from './dto/cabling-response.dto';
import type { CreateNodeInput, UpdateNodeInput } from './dto/create-node.dto';
import type { CustomerDropInput } from './dto/customer-drop.dto';
import type { NetworkNodeResponse } from './dto/topology-response.dto';
import type { UpdateCableRouteInput } from './dto/update-cable-route.dto';
import { customerNetStatus, findSubscriber } from './topology.fixtures';
import { toCableResponse, toNodeResponse } from './topology.mappers';
import { TopologyRepository } from './topology.repository';

/**
 * Write surface for the topology + OSP cabling layer: the node form (create /
 * edit / delete an infra node), the cable re-route, and the "Pasang pelanggan"
 * customer-drop install. Thin orchestration — it resolves the synthetic
 * subscriber (mock-first island, ADR-0003) and maps the result; the repository
 * owns the transactional capacity cascade (allocate / free / re-home). Seeds on
 * first access so a fresh DB is installable.
 */
@Injectable()
export class TopologyMutationService {
  constructor(private readonly repo: TopologyRepository) {}

  /** Create an infra node (customers go through customerDrop, not here). */
  async createNode(body: CreateNodeInput): Promise<NetworkNodeResponse> {
    await this.repo.ensureSeeded();
    // Infra meta only carries the device facts; splitter/ports/coreNo are a
    // read-time projection, never written here.
    const meta: NodeMeta = {
      ...(body.ipAddress !== undefined ? { ipAddress: body.ipAddress } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
    };
    // An ODC/ODP always gets a splitter; default the ratio per type when omitted.
    const splitterRatio =
      body.type === 'odc' || body.type === 'odp'
        ? (body.splitterRatio ?? (body.type === 'odc' ? '1:4' : '1:8'))
        : null;
    const node = await this.repo.createNode({
      name: body.name,
      type: body.type,
      status: body.status,
      parentId: body.parentId,
      lat: body.lat,
      lng: body.lng,
      meta: Object.keys(meta).length > 0 ? meta : null,
      splitterRatio,
    });
    return toNodeResponse(node);
  }

  /** Patch a node; a moved customer is re-homed onto its new serving ODP. */
  async updateNode(id: string, body: UpdateNodeInput): Promise<NetworkNodeResponse> {
    await this.repo.ensureSeeded();
    const found = await this.repo.findNode(id);
    if (!found) throw new NotFoundException('Node tidak ditemukan');
    // A customer re-home needs the subscriber's PON/ONU facts for the new circuit.
    const customerId = found.type === 'customer' ? found.meta?.customerId : undefined;
    const sub = customerId ? findSubscriber(customerId) : undefined;
    const conn = sub?.connection
      ? { ponPort: sub.connection.ponPort, onuSerial: sub.connection.onuSerial }
      : null;
    const node = await this.repo.updateNode(id, body, conn);
    return toNodeResponse(node);
  }

  /** Delete a node, cascade-freeing its cabling. 404 when it is gone. */
  async deleteNode(id: string): Promise<void> {
    await this.repo.ensureSeeded();
    const ok = await this.repo.deleteNode(id);
    if (!ok) throw new NotFoundException('Node tidak ditemukan');
  }

  /** Replace a cable's surveyed route; recompute its length. */
  async updateCableRoute(id: string, body: UpdateCableRouteInput): Promise<CableResponse> {
    await this.repo.ensureSeeded();
    const cable = await this.repo.updateCableRoute(id, body.route);
    if (!cable) throw new NotFoundException('Kabel tidak ditemukan');
    return toCableResponse(cable);
  }

  /** Install a provisioned subscriber onto a target ODP ("Pasang pelanggan"). */
  async customerDrop(body: CustomerDropInput): Promise<NetworkNodeResponse> {
    await this.repo.ensureSeeded();
    const sub = findSubscriber(body.customerId);
    if (!sub) throw new NotFoundException('Pelanggan tidak ditemukan');
    // Build the pass-through meta exactly like the seed customer nodes do; the
    // repository overlays the allocated coreNo on top.
    const metaBase: NodeMeta = {
      customerId: sub.id,
      planName: sub.planName,
      lifecycle: sub.status,
      ...(sub.connection?.rxPower != null ? { rxPowerDbm: sub.connection.rxPower } : {}),
      ...(sub.connection?.onuSerial ? { onuSerial: sub.connection.onuSerial } : {}),
      ...(sub.connection?.ponPort ? { ponPort: sub.connection.ponPort } : {}),
      ...(sub.phone ? { phone: sub.phone } : {}),
    };
    const node = await this.repo.customerDrop({
      customerId: sub.id,
      customerNodeId: `${sub.id}-node`,
      odpId: body.odpId,
      name: sub.fullName,
      netStatus: customerNetStatus(sub.status),
      lat: body.lat,
      lng: body.lng,
      ...(body.portNo !== undefined ? { portNo: body.portNo } : {}),
      metaBase,
      conn: {
        ponPort: sub.connection?.ponPort ?? null,
        onuSerial: sub.connection?.onuSerial ?? null,
      },
    });
    return toNodeResponse(node);
  }
}
