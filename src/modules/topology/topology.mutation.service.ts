import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type {
  NetworkNodeRow,
  NodeMeta,
} from '../../infrastructure/database/schema/topology.schema';
import { type CustomerTopologyRow, CustomersRepository } from '../customers/customers.repository';
import type { CableResponse } from './dto/cabling-response.dto';
import type { CreateNodeInput, UpdateNodeInput } from './dto/create-node.dto';
import type { CustomerDropInput } from './dto/customer-drop.dto';
import type { NetworkNodeResponse } from './dto/topology-response.dto';
import type { UpdateCableRouteInput } from './dto/update-cable-route.dto';
import { toCableResponse, toNodeResponse } from './topology.mappers';
import { TopologyRepository } from './topology.repository';

// NETWORK status (map colour) is distinct from BILLING lifecycle: an isolir
// (suspended) customer is still optically `up` (fiber not cut), so dispatch never
// mistakes "belum bayar" for "fiber putus". Anything not yet / no longer
// provisioned is `unknown`.
const NET_STATUS: Record<CustomerTopologyRow['status'], NetworkNodeRow['status']> = {
  aktif: 'up',
  isolir: 'up',
  berhenti: 'unknown',
  instalasi: 'unknown',
  prospek: 'unknown',
};

/**
 * Write surface for the topology + OSP cabling layer: the node form (create /
 * edit / delete an infra node), the cable re-route, and the "Pasang pelanggan"
 * customer-drop install. Thin orchestration — it resolves the customer from
 * the customers table (its lat/lng place the map node) and maps the result; the repository
 * owns the transactional capacity cascade (allocate / free / re-home). Seeds on
 * first access so a fresh DB is installable.
 */
@Injectable()
export class TopologyMutationService {
  constructor(
    private readonly repo: TopologyRepository,
    private readonly customers: CustomersRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TopologyMutationService.name);
  }

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
    // Only a re-home needs the customers table: a rename / drag / maintenance
    // PATCH must not depend on it (seeded demo nodes carry non-uuid customer ids).
    const customerId = found.type === 'customer' ? found.meta?.customerId : undefined;
    const rehoming = body.parentId !== undefined && body.parentId !== found.parentId;
    if (customerId && rehoming) await this.requireCustomer(customerId);
    // Keep the provisioned PON/ONU: the repository rewrites the drop from this.
    const node = await this.repo.updateNode(id, body, {
      ponPort: found.meta?.ponPort ?? null,
      onuSerial: found.meta?.onuSerial ?? null,
    });
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

  /** Install a customer onto a target ODP ("Pasang pelanggan"). */
  async customerDrop(body: CustomerDropInput, actorId?: string): Promise<NetworkNodeResponse> {
    await this.repo.ensureSeeded();
    const customer = await this.requireCustomer(body.customerId);
    // customers.lat/lng is the source of truth for the node position.
    const { lat, lng } = await this.resolveCoordinates(customer, body, actorId);
    // rxPower is not stored on the customer row, so it stays out of the meta.
    const metaBase: NodeMeta = {
      customerId: customer.id,
      lifecycle: customer.status,
      ...(customer.planName ? { planName: customer.planName } : {}),
      ...(customer.phone ? { phone: customer.phone } : {}),
    };
    const node = await this.repo.customerDrop({
      customerId: customer.id,
      customerNodeId: `${customer.id}-node`,
      odpId: body.odpId,
      name: customer.fullName,
      netStatus: NET_STATUS[customer.status],
      lat,
      lng,
      ...(body.portNo !== undefined ? { portNo: body.portNo } : {}),
      metaBase,
      conn: { ponPort: null, onuSerial: null },
    });
    return toNodeResponse(node);
  }

  private async requireCustomer(customerId: string): Promise<CustomerTopologyRow> {
    // Non-uuid ids (seeded demo nodes) cannot exist in the uuid column.
    if (!z.uuid().safeParse(customerId).success) {
      throw new NotFoundException('Pelanggan tidak ditemukan');
    }
    const customer = await this.customers.findForTopology(customerId);
    if (!customer) throw new NotFoundException('Pelanggan tidak ditemukan');
    return customer;
  }

  /**
   * Stored coordinates win. A customer without any adopts the map click: the
   * customer is written first (conditional, never overwriting a concurrent edit;
   * when it lost the race the stored value is re-read), the node second. No
   * transaction across the two tables: if the node insert then fails, the
   * customer simply keeps the coordinates, which is acceptable.
   */
  private async resolveCoordinates(
    customer: CustomerTopologyRow,
    body: CustomerDropInput,
    actorId?: string,
  ): Promise<{ lat: number; lng: number }> {
    if (customer.lat !== null && customer.lng !== null) {
      return { lat: customer.lat, lng: customer.lng };
    }
    if (body.lat === undefined || body.lng === undefined) return this.requireCoordinates(customer);
    const updated = await this.customers.setLocation(customer.id, body.lat, body.lng);
    if (updated) {
      // Traceability: a technician just set the customer's location (same
      // `audit: true` shape the AuditInterceptor logs).
      this.logger.info(
        {
          audit: true,
          action: 'customer.set-location',
          actor: actorId ?? null,
          target: { customerId: customer.id },
          setLocation: true,
          outcome: 'success',
        },
        'audit event',
      );
      return { lat: body.lat, lng: body.lng };
    }
    return this.requireCoordinates(await this.requireCustomer(customer.id));
  }

  /** 422 when the customer has no coordinates to place it on the map. */
  private requireCoordinates(customer: CustomerTopologyRow): { lat: number; lng: number } {
    if (customer.lat === null || customer.lng === null) {
      throw new UnprocessableEntityException(
        `Customer ${customer.customerNo} has no coordinates; set its location before placing it on the map`,
      );
    }
    return { lat: customer.lat, lng: customer.lng };
  }
}
