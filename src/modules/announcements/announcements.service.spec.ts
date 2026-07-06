import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Announcement } from '../../infrastructure/database/schema/announcements.schema';
import { AnnouncementsRepository } from './announcements.repository';
import { AnnouncementsService } from './announcements.service';

const row = (over: Partial<Announcement> = {}): Announcement => ({
  id: '00000000-0000-0000-0000-0000000000a1',
  title: 'Pemeliharaan jaringan',
  body: 'Layanan dapat terputus sesaat.',
  severity: 'info',
  active: true,
  startsAt: null,
  endsAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  ...over,
});

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      listActive: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      deactivate: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AnnouncementsService, { provide: AnnouncementsRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(AnnouncementsService);
  });

  describe('listActive', () => {
    it('seeds then maps active rows, nullable window fields pass through as null', async () => {
      repo.listActive.mockResolvedValue([row()]);
      const result = await service.listActive();
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          id: '00000000-0000-0000-0000-0000000000a1',
          title: 'Pemeliharaan jaringan',
          body: 'Layanan dapat terputus sesaat.',
          severity: 'info',
          active: true,
          startsAt: null,
          endsAt: null,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ]);
    });

    it('serialises a non-null window to an ISO string', async () => {
      repo.listActive.mockResolvedValue([
        row({
          startsAt: new Date('2026-07-01T00:00:00.000Z'),
          endsAt: new Date('2026-07-02T00:00:00.000Z'),
        }),
      ]);
      const result = await service.listActive();
      expect(result[0]?.startsAt).toBe('2026-07-01T00:00:00.000Z');
      expect(result[0]?.endsAt).toBe('2026-07-02T00:00:00.000Z');
    });

    it('windowing itself is the repository`s job — the service surfaces exactly what listActive returns', async () => {
      // Simulates the repo already having excluded an inactive/out-of-window row.
      repo.listActive.mockResolvedValue([row({ id: 'a1' }), row({ id: 'a2', severity: 'outage' })]);
      const result = await service.listActive();
      expect(result.map((r) => r.id)).toEqual(['a1', 'a2']);
    });

    it('returns an empty list when nothing is active', async () => {
      repo.listActive.mockResolvedValue([]);
      expect(await service.listActive()).toEqual([]);
    });
  });

  describe('list (admin)', () => {
    it('seeds then maps every row regardless of active/window', async () => {
      repo.list.mockResolvedValue([row({ active: false })]);
      const result = await service.list();
      expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
      expect(result[0]?.active).toBe(false);
    });
  });

  describe('create', () => {
    it('parses ISO window strings to Date before handing off to the repository', async () => {
      repo.create.mockResolvedValue(row());
      await service.create({
        title: 'Pemeliharaan jaringan',
        body: 'Layanan dapat terputus sesaat.',
        severity: 'info',
        active: true,
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-07-02T00:00:00.000Z',
      });
      expect(repo.create).toHaveBeenCalledWith({
        title: 'Pemeliharaan jaringan',
        body: 'Layanan dapat terputus sesaat.',
        severity: 'info',
        active: true,
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        endsAt: new Date('2026-07-02T00:00:00.000Z'),
      });
    });

    it('defaults an absent window to null', async () => {
      repo.create.mockResolvedValue(row());
      await service.create({
        title: 'x',
        body: 'y',
        severity: 'warning',
        active: true,
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ startsAt: null, endsAt: null }),
      );
    });
  });

  describe('deactivate', () => {
    it('flips active to false and returns the updated row', async () => {
      repo.deactivate.mockResolvedValue(row({ active: false }));
      const result = await service.deactivate('a1');
      expect(repo.deactivate).toHaveBeenCalledWith('a1');
      expect(result.active).toBe(false);
    });

    it('404s when the announcement does not exist', async () => {
      repo.deactivate.mockResolvedValue(null);
      await expect(service.deactivate('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
