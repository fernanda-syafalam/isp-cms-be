import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PppProfile } from '../../infrastructure/database/schema/pppoe.schema';
import { RoutersRepository } from '../routers/routers.repository';
import type { CreateProfileInput, ProfileResponse, UpdateProfileInput } from './dto/profile.dto';
import { ProfilesRepository } from './profiles.repository';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly repo: ProfilesRepository,
    private readonly routers: RoutersRepository,
  ) {}

  async list(routerId: string): Promise<{ items: ProfileResponse[]; total: number }> {
    await this.requireRouter(routerId);
    const { items, total } = await this.repo.listByRouter(routerId);
    return { items: items.map(toProfileResponse), total };
  }

  async create(routerId: string, input: CreateProfileInput): Promise<ProfileResponse> {
    await this.requireRouter(routerId);
    const profile = await this.repo.create({
      routerId,
      name: input.name,
      rateLimit: input.rateLimit,
    });
    this.logger.log({ routerId, profileId: profile.id }, 'profile created');
    return toProfileResponse(profile);
  }

  async update(routerId: string, id: string, input: UpdateProfileInput): Promise<ProfileResponse> {
    await this.requireOwnedProfile(routerId, id);
    return toProfileResponse(await this.repo.update(id, input));
  }

  async remove(routerId: string, id: string): Promise<void> {
    await this.requireOwnedProfile(routerId, id);
    await this.repo.remove(id);
  }

  private async requireRouter(routerId: string): Promise<void> {
    const router = await this.routers.findById(routerId);
    if (!router) throw new NotFoundException('router not found');
  }

  // Guards against editing a profile through the wrong router's path.
  private async requireOwnedProfile(routerId: string, id: string): Promise<void> {
    const profile = await this.repo.findById(id);
    if (!profile || profile.routerId !== routerId) {
      throw new NotFoundException('profile not found');
    }
  }
}

function toProfileResponse(row: PppProfile): ProfileResponse {
  return {
    id: row.id,
    routerId: row.routerId,
    name: row.name,
    rateLimit: row.rateLimit,
    isIsolir: row.isIsolir,
  };
}
