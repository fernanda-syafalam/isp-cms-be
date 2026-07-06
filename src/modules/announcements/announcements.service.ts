import { Injectable, NotFoundException } from '@nestjs/common';
import type { Announcement } from '../../infrastructure/database/schema/announcements.schema';
import { buildAnnouncementFixture } from './announcements.fixtures';
import { AnnouncementsRepository } from './announcements.repository';
import type { AnnouncementResponse } from './dto/announcement-response.dto';
import type { CreateAnnouncementInput } from './dto/create-announcement.dto';

/**
 * Portal/staff announcements & outage notices. Self-seeds its fixture on
 * first access (mock-first island, ADR-0003).
 */
@Injectable()
export class AnnouncementsService {
  constructor(private readonly repo: AnnouncementsRepository) {}

  /** Portal-facing feed — active rows within their visibility window, newest first. */
  async listActive(): Promise<AnnouncementResponse[]> {
    await this.repo.ensureSeeded(buildAnnouncementFixture());
    const rows = await this.repo.listActive();
    return rows.map(toAnnouncementResponse);
  }

  /** Staff admin view — every row regardless of active/window. */
  async list(): Promise<AnnouncementResponse[]> {
    await this.repo.ensureSeeded(buildAnnouncementFixture());
    const rows = await this.repo.list();
    return rows.map(toAnnouncementResponse);
  }

  async create(input: CreateAnnouncementInput): Promise<AnnouncementResponse> {
    const row = await this.repo.create({
      title: input.title,
      body: input.body,
      severity: input.severity,
      active: input.active,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
    });
    return toAnnouncementResponse(row);
  }

  /** Soft-disable — the row stays for history, only `active` flips to false. */
  async deactivate(id: string): Promise<AnnouncementResponse> {
    const row = await this.repo.deactivate(id);
    if (!row) throw new NotFoundException('pengumuman tidak ditemukan');
    return toAnnouncementResponse(row);
  }
}

function toAnnouncementResponse(row: Announcement): AnnouncementResponse {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    active: row.active,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
