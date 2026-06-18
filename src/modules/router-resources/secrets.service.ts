import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PppSecret } from '../../infrastructure/database/schema/pppoe.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { RoutersRepository } from '../routers/routers.repository';
import type {
  CreateSecretInput,
  SecretListItem,
  SecretResponse,
  UpdateSecretInput,
} from './dto/secret.dto';
import { ProfilesRepository } from './profiles.repository';
import type { SecretListFilter } from './secrets.repository';
import { SecretsRepository } from './secrets.repository';
import { deriveConnection } from './session-synthesis';

export type { SecretListFilter };

@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);

  constructor(
    private readonly repo: SecretsRepository,
    private readonly profiles: ProfilesRepository,
    private readonly routers: RoutersRepository,
    private readonly customers: CustomersRepository,
  ) {}

  async list(
    routerId: string,
    filter: SecretListFilter,
  ): Promise<{ items: SecretListItem[]; total: number }> {
    await this.requireRouter(routerId);
    const { items, total } = await this.repo.listByRouter(routerId, filter);
    return { items: items.map(toSecretListItem), total };
  }

  /** Create a secret, denormalising the profile name + maintaining secretCount. */
  async create(routerId: string, input: CreateSecretInput): Promise<SecretResponse> {
    await this.requireRouter(routerId);
    const profileName = await this.requireProfileName(routerId, input.profileId);
    const customerId = input.customerName
      ? await this.customers.findIdByFullName(input.customerName)
      : null;

    const secret = await this.repo.create({
      routerId,
      username: input.username,
      profileId: input.profileId,
      profileName,
      customerId,
      customerName: input.customerName ?? null,
      comment: input.comment ?? null,
    });
    await this.routers.adjustSecretCount(routerId, 1);
    this.logger.log({ routerId, secretId: secret.id }, 'secret created');
    return toSecretResponse(secret);
  }

  async update(routerId: string, id: string, input: UpdateSecretInput): Promise<SecretResponse> {
    await this.requireOwnedSecret(routerId, id);

    const patch: Parameters<SecretsRepository['update']>[1] = {};
    if (input.username !== undefined) patch.username = input.username;
    if (input.disabled !== undefined) patch.disabled = input.disabled;
    if (input.comment !== undefined) patch.comment = input.comment;
    if (input.profileId !== undefined) {
      patch.profileId = input.profileId;
      patch.profileName = await this.requireProfileName(routerId, input.profileId);
    }
    if (input.customerName !== undefined) {
      patch.customerName = input.customerName;
      patch.customerId = input.customerName
        ? await this.customers.findIdByFullName(input.customerName)
        : null;
    }
    // password is intentionally not persisted (RouterOS owns it).
    return toSecretResponse(await this.repo.update(id, patch));
  }

  async remove(routerId: string, id: string): Promise<void> {
    await this.requireOwnedSecret(routerId, id);
    await this.repo.remove(id);
    await this.routers.adjustSecretCount(routerId, -1);
  }

  private async requireRouter(routerId: string): Promise<void> {
    const router = await this.routers.findById(routerId);
    if (!router) throw new NotFoundException('router not found');
  }

  // Resolve the profile name, asserting it belongs to this router (400 if not).
  private async requireProfileName(routerId: string, profileId: string): Promise<string> {
    const profile = await this.profiles.findById(profileId);
    if (!profile || profile.routerId !== routerId) {
      throw new BadRequestException('profile not found on this router');
    }
    return profile.name;
  }

  private async requireOwnedSecret(routerId: string, id: string): Promise<PppSecret> {
    const secret = await this.repo.findById(id);
    if (!secret || secret.routerId !== routerId) {
      throw new NotFoundException('secret not found');
    }
    return secret;
  }
}

function toSecretResponse(row: PppSecret): SecretResponse {
  return {
    id: row.id,
    routerId: row.routerId,
    username: row.username,
    profileId: row.profileId,
    profileName: row.profileName,
    customerId: row.customerId,
    customerName: row.customerName,
    disabled: row.disabled,
    comment: row.comment,
  };
}

function toSecretListItem(row: PppSecret): SecretListItem {
  const online = !row.disabled;
  const conn = online ? deriveConnection(row.id) : null;
  return {
    ...toSecretResponse(row),
    online,
    address: conn?.address ?? null,
    uptime: conn?.uptime ?? null,
    // sessionId = secret.id when online (session is derived 1:1 from secret)
    sessionId: online ? row.id : null,
  };
}
