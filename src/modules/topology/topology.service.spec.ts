import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CableRow,
  NetworkNodeRow,
  SplitterRow,
  StrandRow,
} from '../../infrastructure/database/schema/topology.schema';
import { TopologyRepository } from './topology.repository';
import { TopologyService } from './topology.service';

const odpNode: NetworkNodeRow = {
  id: 'olt-1-odc-1-odp-1',
  name: 'ODP 1.1.1',
  type: 'odp',
  status: 'up',
  lat: -6.55,
  lng: 110.68,
  parentId: 'olt-1-odc-1',
  meta: { splitter: '1:8', portsUsed: 99, portsTotal: 8, rxPowerDbm: -22 },
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T00:00:00.000Z'),
};

const odpSplitter: SplitterRow = {
  id: 'olt-1-odc-1-odp-1-splitter',
  nodeId: 'olt-1-odc-1-odp-1',
  ratio: '1:8',
  inCableId: null,
  inStrandId: null,
  ports: [
    { portNo: 1, outNodeId: 'cust-1-node', customerId: 'cust-1', strandId: 'cust-1-node-strand' },
    { portNo: 2, outNodeId: null, customerId: null, strandId: null },
  ],
};

const dropCable: CableRow = {
  id: 'cust-1-node-drop',
  kind: 'drop',
  spec: 'G.652D 12F drop',
  fiberCount: 12,
  tubeCount: 1,
  fromNodeId: 'olt-1-odc-1-odp-1',
  toNodeId: 'cust-1-node',
  route: [
    { lat: -6.55, lng: 110.68 },
    { lat: -6.551, lng: 110.681 },
  ],
  lengthM: 142,
  status: 'installed',
  installedAt: new Date('2026-06-10T08:00:00.000Z'),
};

describe('TopologyService', () => {
  let service: TopologyService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      listNodes: vi.fn(),
      listCables: vi.fn(),
      listStrands: vi.fn(),
      listSplitters: vi.fn(),
      listClosures: vi.fn(),
      listSplices: vi.fn(),
      listCircuits: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [TopologyService, { provide: TopologyRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(TopologyService);
  });

  describe('getTopology', () => {
    it('seeds, then returns nodes with read-time projected meta (honest portsUsed)', async () => {
      repo.listNodes.mockResolvedValue([odpNode]);
      repo.listSplitters.mockResolvedValue([odpSplitter]);
      repo.listStrands.mockResolvedValue([] as StrandRow[]);

      const { items, total } = await service.getTopology();

      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(total).toBe(1);
      // portsUsed is recomputed from real occupancy (1), overriding the seeded 99.
      expect(items[0]?.meta?.portsUsed).toBe(1);
      expect(items[0]?.meta?.portsTotal).toBe(8);
      expect(items[0]?.meta?.rxPowerDbm).toBe(-22); // pass-through preserved
    });
  });

  describe('listCables', () => {
    it('maps installedAt Date to an ISO string and wraps with total', async () => {
      repo.listCables.mockResolvedValue([dropCable]);
      const { items, total } = await service.listCables();
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(total).toBe(1);
      expect(items[0]?.installedAt).toBe('2026-06-10T08:00:00.000Z');
      expect(items[0]?.kind).toBe('drop');
    });

    it('keeps a null installedAt null', async () => {
      repo.listCables.mockResolvedValue([{ ...dropCable, installedAt: null }]);
      const { items } = await service.listCables();
      expect(items[0]?.installedAt).toBeNull();
    });
  });

  describe('listSplitters', () => {
    it('passes splitter ports through unchanged', async () => {
      repo.listSplitters.mockResolvedValue([odpSplitter]);
      const { items, total } = await service.listSplitters();
      expect(total).toBe(1);
      expect(items[0]?.ports).toHaveLength(2);
      expect(items[0]?.ports[0]?.customerId).toBe('cust-1');
    });
  });
});
