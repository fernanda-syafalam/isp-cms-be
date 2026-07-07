import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { userSecurity, userSessions } from '../../infrastructure/database/schema/security.schema';
import { SecurityRepository } from './security.repository';

/**
 * Real Postgres integration test for SecurityRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0023 + 0044).
 */
describe('SecurityRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: SecurityRepository;

  const userA = '00000000-0000-0000-0000-0000000000a1';
  const userB = '00000000-0000-0000-0000-0000000000b2';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TABLE user_security (
        user_id uuid PRIMARY KEY,
        two_factor_enabled boolean NOT NULL DEFAULT false,
        two_factor_secret varchar(64),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE user_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        device varchar(200) NOT NULL,
        ip varchar(60) NOT NULL,
        last_active_at timestamptz(3) NOT NULL DEFAULT now(),
        is_current boolean NOT NULL DEFAULT false,
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
    `);

    repo = new SecurityRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(userSessions);
    await db.delete(userSecurity);
  });

  it('creates the state row idempotently', async () => {
    await repo.ensureState(userA);
    await repo.ensureState(userA);
    const state = await repo.findState(userA);
    expect(state?.twoFactorEnabled).toBe(false);
    const rows = await db.select().from(userSecurity);
    expect(rows).toHaveLength(1);
  });

  it('stores a secret without enabling, then confirms', async () => {
    await repo.ensureState(userA);
    await repo.saveTwoFactorSecret(userA, 'JBSWY3DPEHPK3PXP');
    const enrolled = await repo.findState(userA);
    expect(enrolled?.twoFactorSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(enrolled?.twoFactorEnabled).toBe(false);

    await repo.confirmTwoFactor(userA);
    expect((await repo.findState(userA))?.twoFactorEnabled).toBe(true);
  });

  it('clears the secret and flag on disable', async () => {
    await repo.ensureState(userA);
    await repo.saveTwoFactorSecret(userA, 'JBSWY3DPEHPK3PXP');
    await repo.confirmTwoFactor(userA);

    await repo.clearTwoFactor(userA);
    const state = await repo.findState(userA);
    expect(state?.twoFactorEnabled).toBe(false);
    expect(state?.twoFactorSecret).toBeNull();
  });

  it('resets the enabled flag to false when a new secret is saved (re-enrollment)', async () => {
    await repo.ensureState(userA);
    await repo.saveTwoFactorSecret(userA, 'JBSWY3DPEHPK3PXP');
    await repo.confirmTwoFactor(userA);

    await repo.saveTwoFactorSecret(userA, 'NEWSECRETVALUE22');
    const state = await repo.findState(userA);
    expect(state?.twoFactorEnabled).toBe(false);
    expect(state?.twoFactorSecret).toBe('NEWSECRETVALUE22');
  });

  it('seeds + lists sessions current-first', async () => {
    await repo.seedSessions([
      { userId: userA, device: 'Safari di iPhone', ip: '103.28.12.9', isCurrent: false },
      { userId: userA, device: 'Chrome di Windows', ip: '103.28.12.4', isCurrent: true },
    ]);
    expect(await repo.countSessions(userA)).toBe(2);
    const sessions = await repo.listSessions(userA);
    expect(sessions[0]?.isCurrent).toBe(true);
    expect(sessions[0]?.device).toBe('Chrome di Windows');
  });

  it('revokes a single session scoped to its owner', async () => {
    await repo.seedSessions([
      { userId: userA, device: 'Chrome di Windows', ip: '1.1.1.1', isCurrent: true },
      { userId: userB, device: 'Firefox di Linux', ip: '2.2.2.2', isCurrent: true },
    ]);
    const [aSession] = await repo.listSessions(userA);
    if (!aSession) throw new Error('seed missing');

    // User B cannot revoke user A's session.
    expect(await repo.deleteSession(aSession.id, userB)).toBe(false);
    // The owner can.
    expect(await repo.deleteSession(aSession.id, userA)).toBe(true);
    expect(await repo.countSessions(userA)).toBe(0);
    expect(await repo.countSessions(userB)).toBe(1);
  });

  it('revokes other sessions but keeps the current one', async () => {
    await repo.seedSessions([
      { userId: userA, device: 'Chrome di Windows', ip: '1.1.1.1', isCurrent: true },
      { userId: userA, device: 'Safari di iPhone', ip: '1.1.1.2', isCurrent: false },
      { userId: userA, device: 'Edge di Windows', ip: '1.1.1.3', isCurrent: false },
    ]);
    await repo.deleteOtherSessions(userA);
    const remaining = await repo.listSessions(userA);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isCurrent).toBe(true);
  });
});
