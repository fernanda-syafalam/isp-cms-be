import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CableRow,
  NetworkNodeRow,
} from '../../infrastructure/database/schema/topology.schema';
import { TopologyMutationService } from './topology.mutation.service';
import { TopologyRepository } from './topology.repository';

const customerNode: NetworkNodeRow = {
  id: 'cust-12-node',
  name: 'Lukman Hakim',
  type: 'customer',
  status: 'up',
  lat: -6.55,
  lng: 110.68,
  parentId: 'olt-1-odc-1-odp-1',
  meta: { customerId: 'cust-12', planName: 'Home 50', coreNo: 3, lifecycle: 'aktif' },
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T00:00:00.000Z'),
};

const odpNode: NetworkNodeRow = {
  ...customerNode,
  id: 'new-odp',
  name: 'ODP Baru',
  type: 'odp',
  parentId: 'olt-1-odc-1',
  meta: null,
};

const cable: CableRow = {
  id: 'cust-1-node-drop',
  kind: 'drop',
  spec: 'G.652D 12F drop',
  fiberCount: 12,
  tubeCount: 1,
  fromNodeId: 'olt-1-odc-1-odp-1',
  toNodeId: 'cust-1-node',
  route: [
    { lat: -6.55, lng: 110.68 },
    { lat: -6.56, lng: 110.69 },
  ],
  lengthM: 1500,
  status: 'installed',
  installedAt: null,
};

describe('TopologyMutationService', () => {
  let service: TopologyMutationService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      findNode: vi.fn(),
      findCable: vi.fn(),
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      updateCableRoute: vi.fn(),
      customerDrop: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [TopologyMutationService, { provide: TopologyRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(TopologyMutationService);
  });

  describe('createNode', () => {
    it('provisions an ODP splitter with the default ratio when omitted', async () => {
      repo.createNode.mockResolvedValue(odpNode);
      await service.createNode({
        name: 'ODP Baru',
        type: 'odp',
        status: 'up',
        parentId: 'olt-1-odc-1',
        lat: -6.55,
        lng: 110.68,
      });
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(repo.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'odp', splitterRatio: '1:8' }),
      );
    });

    it('keeps OLT/pole nodes splitter-less and carries device meta', async () => {
      repo.createNode.mockResolvedValue({ ...odpNode, type: 'olt' });
      await service.createNode({
        name: 'OLT Baru',
        type: 'olt',
        status: 'up',
        parentId: null,
        lat: -6.55,
        lng: 110.68,
        ipAddress: '10.20.9.1',
        model: 'ZTE C320',
      });
      expect(repo.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          splitterRatio: null,
          meta: { ipAddress: '10.20.9.1', model: 'ZTE C320' },
        }),
      );
    });
  });

  describe('customerDrop', () => {
    it('resolves the subscriber and forwards a built meta + connection', async () => {
      repo.customerDrop.mockResolvedValue(customerNode);
      const result = await service.customerDrop({
        customerId: 'cust-12',
        odpId: 'olt-1-odc-1-odp-1',
        lat: -6.55,
        lng: 110.68,
      });
      expect(result.id).toBe('cust-12-node');
      expect(repo.customerDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-12',
          customerNodeId: 'cust-12-node',
          name: 'Lukman Hakim',
          netStatus: 'up',
          conn: { ponPort: '0/3/3', onuSerial: 'ZTEG10000012' },
          metaBase: expect.objectContaining({
            customerId: 'cust-12',
            planName: 'Home 50',
            lifecycle: 'aktif',
            onuSerial: 'ZTEG10000012',
          }),
        }),
      );
    });

    it('throws 404 for an unknown subscriber', async () => {
      await expect(
        service.customerDrop({ customerId: 'ghost', odpId: 'odp-1', lat: 0, lng: 0 }),
      ).rejects.toThrow('Pelanggan tidak ditemukan');
      expect(repo.customerDrop).not.toHaveBeenCalled();
    });
  });

  describe('updateNode', () => {
    it('throws 404 before delegating when the node is gone', async () => {
      repo.findNode.mockResolvedValue(undefined);
      await expect(service.updateNode('nope', { name: 'x' })).rejects.toThrow(
        'Node tidak ditemukan',
      );
      expect(repo.updateNode).not.toHaveBeenCalled();
    });

    it('passes the subscriber connection through for a customer re-home', async () => {
      repo.findNode.mockResolvedValue(customerNode);
      repo.updateNode.mockResolvedValue({ ...customerNode, parentId: 'olt-2-odc-2-odp-2' });
      await service.updateNode('cust-12-node', { parentId: 'olt-2-odc-2-odp-2' });
      expect(repo.updateNode).toHaveBeenCalledWith(
        'cust-12-node',
        { parentId: 'olt-2-odc-2-odp-2' },
        { ponPort: '0/3/3', onuSerial: 'ZTEG10000012' },
      );
    });
  });

  describe('deleteNode', () => {
    it('throws 404 when the repository reports nothing removed', async () => {
      repo.deleteNode.mockResolvedValue(false);
      await expect(service.deleteNode('nope')).rejects.toThrow('Node tidak ditemukan');
    });

    it('resolves when the node was removed', async () => {
      repo.deleteNode.mockResolvedValue(true);
      await expect(service.deleteNode('cust-12-node')).resolves.toBeUndefined();
    });
  });

  describe('updateCableRoute', () => {
    it('throws 404 for a missing cable', async () => {
      repo.updateCableRoute.mockResolvedValue(undefined);
      await expect(
        service.updateCableRoute('nope', {
          route: [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ],
        }),
      ).rejects.toThrow('Kabel tidak ditemukan');
    });

    it('maps the updated cable', async () => {
      repo.updateCableRoute.mockResolvedValue(cable);
      const result = await service.updateCableRoute('cust-1-node-drop', {
        route: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
        ],
      });
      expect(result.id).toBe('cust-1-node-drop');
      expect(result.lengthM).toBe(1500);
    });
  });
});
