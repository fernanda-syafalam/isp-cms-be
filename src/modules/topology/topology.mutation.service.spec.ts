import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CableRow,
  NetworkNodeRow,
} from '../../infrastructure/database/schema/topology.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { TopologyMutationService } from './topology.mutation.service';
import { TopologyRepository } from './topology.repository';

const customerNode: NetworkNodeRow = {
  id: '11111111-1111-4111-8111-111111111111-node',
  name: 'Lukman Hakim',
  type: 'customer',
  status: 'up',
  lat: -6.55,
  lng: 110.68,
  parentId: 'olt-1-odc-1-odp-1',
  meta: {
    customerId: '11111111-1111-4111-8111-111111111111',
    planName: 'Home 50',
    coreNo: 3,
    lifecycle: 'aktif',
    ponPort: '0/3/3',
    onuSerial: 'ZTEG10000012',
  },
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
  let logger: { setContext: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    findForTopology: ReturnType<typeof vi.fn>;
    setLocation: ReturnType<typeof vi.fn>;
  };

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
    logger = { setContext: vi.fn(), info: vi.fn() };
    customers = { findForTopology: vi.fn(), setLocation: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TopologyMutationService,
        { provide: TopologyRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: PinoLogger, useValue: logger },
      ],
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
    const dropBody = {
      customerId: '11111111-1111-4111-8111-111111111111',
      odpId: 'olt-1-odc-1-odp-1',
      lat: 1,
      lng: 2,
    };
    const dbCustomer = {
      id: '11111111-1111-4111-8111-111111111111',
      customerNo: 'C-9012',
      fullName: 'Lukman Hakim',
      status: 'aktif' as const,
      lat: -6.55,
      lng: 110.68,
      phone: '081234500012',
      planName: 'Home 50',
    };

    it('places the node at the customer coordinates and maps status to up', async () => {
      customers.findForTopology.mockResolvedValue(dbCustomer);
      repo.customerDrop.mockResolvedValue(customerNode);
      const result = await service.customerDrop(dropBody);
      expect(result.id).toBe('11111111-1111-4111-8111-111111111111-node');
      expect(repo.customerDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: '11111111-1111-4111-8111-111111111111',
          customerNodeId: '11111111-1111-4111-8111-111111111111-node',
          name: 'Lukman Hakim',
          netStatus: 'up',
          lat: -6.55,
          lng: 110.68,
          metaBase: {
            customerId: '11111111-1111-4111-8111-111111111111',
            lifecycle: 'aktif',
            planName: 'Home 50',
            phone: '081234500012',
          },
        }),
      );
    });

    it('keeps an isolir customer up and a berhenti customer unknown', async () => {
      repo.customerDrop.mockResolvedValue(customerNode);
      customers.findForTopology.mockResolvedValueOnce({ ...dbCustomer, status: 'isolir' });
      await service.customerDrop(dropBody);
      customers.findForTopology.mockResolvedValueOnce({ ...dbCustomer, status: 'berhenti' });
      await service.customerDrop(dropBody);
      const statuses = repo.customerDrop.mock.calls.map((c) => c[0].netStatus);
      expect(statuses).toEqual(['up', 'unknown']);
    });

    it('throws 404 for an unknown customer', async () => {
      customers.findForTopology.mockResolvedValue(null);
      await expect(
        service.customerDrop({ ...dropBody, customerId: '22222222-2222-4222-8222-222222222222' }),
      ).rejects.toThrow(NotFoundException);
      expect(repo.customerDrop).not.toHaveBeenCalled();
    });

    it('ignores body coordinates when the customer already has some', async () => {
      customers.findForTopology.mockResolvedValue(dbCustomer);
      repo.customerDrop.mockResolvedValue(customerNode);
      await service.customerDrop(dropBody);
      expect(customers.setLocation).not.toHaveBeenCalled();
    });

    it('adopts the map click for a customer without coordinates', async () => {
      customers.findForTopology.mockResolvedValue({ ...dbCustomer, lat: null, lng: null });
      customers.setLocation.mockResolvedValue(true);
      repo.customerDrop.mockResolvedValue(customerNode);
      await service.customerDrop(dropBody, 'user-1');
      expect(customers.setLocation).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        1,
        2,
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ audit: true, actor: 'user-1', setLocation: true }),
        'audit event',
      );
      expect(repo.customerDrop).toHaveBeenCalledWith(expect.objectContaining({ lat: 1, lng: 2 }));
    });

    it('uses the stored coordinates when the conditional update lost the race', async () => {
      customers.findForTopology
        .mockResolvedValueOnce({ ...dbCustomer, lat: null, lng: null })
        .mockResolvedValueOnce(dbCustomer);
      customers.setLocation.mockResolvedValue(false);
      repo.customerDrop.mockResolvedValue(customerNode);
      await service.customerDrop(dropBody);
      expect(repo.customerDrop).toHaveBeenCalledWith(
        expect.objectContaining({ lat: -6.55, lng: 110.68 }),
      );
    });

    it('throws 422 naming the customer number when coordinates are missing', async () => {
      customers.findForTopology.mockResolvedValue({ ...dbCustomer, lat: null, lng: null });
      const err = await service
        .customerDrop({
          customerId: '11111111-1111-4111-8111-111111111111',
          odpId: 'olt-1-odc-1-odp-1',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as Error).message).toContain('C-9012');
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

    it('resolves the customer from the repository for a customer re-home', async () => {
      repo.findNode.mockResolvedValue(customerNode);
      customers.findForTopology.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        customerNo: 'C-9012',
        fullName: 'Lukman Hakim',
        status: 'aktif',
        lat: null,
        lng: null,
        phone: '0812',
        planName: null,
      });
      repo.updateNode.mockResolvedValue({ ...customerNode, parentId: 'olt-2-odc-2-odp-2' });
      await service.updateNode('11111111-1111-4111-8111-111111111111-node', {
        parentId: 'olt-2-odc-2-odp-2',
      });
      expect(customers.findForTopology).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
      );
      expect(repo.updateNode).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111-node',
        { parentId: 'olt-2-odc-2-odp-2' },
        { ponPort: '0/3/3', onuSerial: 'ZTEG10000012' },
      );
    });

    it('does not touch the customers table for a plain rename / drag', async () => {
      repo.findNode.mockResolvedValue({ ...customerNode, meta: { customerId: 'cust-12' } });
      repo.updateNode.mockResolvedValue(customerNode);
      await service.updateNode('11111111-1111-4111-8111-111111111111-node', { name: 'Renamed' });
      expect(customers.findForTopology).not.toHaveBeenCalled();
    });

    it('answers 404 without querying for a non-uuid customer id on re-home', async () => {
      repo.findNode.mockResolvedValue({ ...customerNode, meta: { customerId: 'cust-12' } });
      await expect(
        service.updateNode('11111111-1111-4111-8111-111111111111-node', {
          parentId: 'olt-2-odc-2-odp-2',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(customers.findForTopology).not.toHaveBeenCalled();
    });

    it('throws 404 when the re-homed customer no longer exists', async () => {
      repo.findNode.mockResolvedValue(customerNode);
      customers.findForTopology.mockResolvedValue(null);
      await expect(
        service.updateNode('11111111-1111-4111-8111-111111111111-node', {
          parentId: 'olt-2-odc-2-odp-2',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(repo.updateNode).not.toHaveBeenCalled();
    });
  });

  describe('deleteNode', () => {
    it('throws 404 when the repository reports nothing removed', async () => {
      repo.deleteNode.mockResolvedValue(false);
      await expect(service.deleteNode('nope')).rejects.toThrow('Node tidak ditemukan');
    });

    it('resolves when the node was removed', async () => {
      repo.deleteNode.mockResolvedValue(true);
      await expect(
        service.deleteNode('11111111-1111-4111-8111-111111111111-node'),
      ).resolves.toBeUndefined();
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
