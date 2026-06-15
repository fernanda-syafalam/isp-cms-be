import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  NewUserSession,
  UserSession,
} from '../../infrastructure/database/schema/security.schema';
import type { SecuritySessionResponse, SecurityStateResponse } from './dto/security-response.dto';
import { SecurityRepository } from './security.repository';

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(private readonly repo: SecurityRepository) {}

  async getState(userId: string): Promise<SecurityStateResponse> {
    await this.ensureSeeded(userId);
    return this.buildState(userId);
  }

  async enableTwoFactor(userId: string, _code: string): Promise<SecurityStateResponse> {
    // The 6-digit shape is validated by the DTO. A real backend verifies the
    // code against the user's TOTP secret; this mock accepts any well-formed
    // code and flips the flag.
    await this.ensureSeeded(userId);
    await this.repo.setTwoFactor(userId, true);
    this.logger.log({ userId }, 'two-factor enabled');
    return this.buildState(userId);
  }

  async disableTwoFactor(userId: string): Promise<SecurityStateResponse> {
    await this.ensureSeeded(userId);
    await this.repo.setTwoFactor(userId, false);
    this.logger.log({ userId }, 'two-factor disabled');
    return this.buildState(userId);
  }

  async revokeSession(userId: string, id: string): Promise<void> {
    const deleted = await this.repo.deleteSession(id, userId);
    if (!deleted) throw new NotFoundException('session not found');
    this.logger.log({ userId, sessionId: id }, 'session revoked');
  }

  async revokeOtherSessions(userId: string): Promise<void> {
    await this.repo.deleteOtherSessions(userId);
    this.logger.log({ userId }, 'other sessions revoked');
  }

  // Seed the per-user state + a representative session list on first access.
  private async ensureSeeded(userId: string): Promise<void> {
    await this.repo.ensureState(userId);
    if ((await this.repo.countSessions(userId)) === 0) {
      await this.repo.seedSessions(buildSeedSessions(userId));
    }
  }

  private async buildState(userId: string): Promise<SecurityStateResponse> {
    const state = await this.repo.findState(userId);
    const sessions = await this.repo.listSessions(userId);
    return {
      twoFactorEnabled: state?.twoFactorEnabled ?? false,
      sessions: sessions.map(toSessionResponse),
    };
  }
}

function buildSeedSessions(userId: string): NewUserSession[] {
  return [
    { userId, device: 'Chrome di Windows', ip: '103.28.12.4', isCurrent: true },
    { userId, device: 'Safari di iPhone', ip: '103.28.12.9', isCurrent: false },
  ];
}

function toSessionResponse(row: UserSession): SecuritySessionResponse {
  return {
    id: row.id,
    device: row.device,
    ip: row.ip,
    lastActiveAt: row.lastActiveAt.toISOString(),
    current: row.isCurrent,
  };
}
