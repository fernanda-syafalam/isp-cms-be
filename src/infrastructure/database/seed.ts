/**
 * Database seed — idempotent. Inserts one known account per role plus a
 * handful of extra customers so the `/v1/users` list has enough rows to
 * exercise cursor pagination. Safe to run repeatedly: rows whose email
 * already exists are skipped (the `users.email` unique constraint is the
 * idempotency key, and the check matches soft-deleted rows too so a
 * re-seed never trips the constraint).
 *
 * Run:
 *   pnpm db:migrate   # apply migrations first (creates the users table)
 *   pnpm db:seed      # reads DATABASE_URL from .env if present, else the
 *                     # docker-compose default
 *
 * The dev passwords printed at the end are for LOCAL DEVELOPMENT ONLY —
 * never reuse these values anywhere real.
 */
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { type User, users } from './schema/users.schema';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';

// Mirrors src/modules/users/users.service.ts ARGON2_OPTIONS (OWASP Password
// Storage Cheat Sheet, Pilar 4) so seeded hashes match production hashing.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// One shared dev password for every seeded account. >= 12 chars to satisfy
// the CreateUserSchema rule. LOCAL DEVELOPMENT ONLY.
const DEV_PASSWORD = 'Passw0rd!2345';

type SeedUser = Pick<User, 'email' | 'fullName' | 'role'>;

// Canonical accounts: one per role, with stable emails for login testing.
const CANONICAL_USERS: SeedUser[] = [
  { email: 'admin@example.com', fullName: 'Ada Admin', role: 'admin' },
  { email: 'staff@example.com', fullName: 'Sam Staff', role: 'staff' },
  {
    email: 'customer@example.com',
    fullName: 'Cara Customer',
    role: 'customer',
  },
  { email: 'teknisi@example.com', fullName: 'Tono Teknisi', role: 'teknisi' },
  // The mitra account is seeded without a resellerId — link it manually (or
  // via the users UI) once a reseller row exists; scoped reads land in P1.5.
  { email: 'mitra@example.com', fullName: 'Mira Mitra', role: 'mitra' },
];

// Extra customers so the list spans more than one page (FE page size is 10).
const EXTRA_CUSTOMERS: SeedUser[] = Array.from({ length: 12 }, (_, i) => ({
  email: `customer${i + 1}@example.com`,
  fullName: `Customer ${i + 1}`,
  role: 'customer',
}));

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool, { schema: { users } });

  // Hash once — every seeded account shares the same dev password.
  const passwordHash = await argon2.hash(DEV_PASSWORD, ARGON2_OPTIONS);
  const seedUsers = [...CANONICAL_USERS, ...EXTRA_CUSTOMERS];

  let created = 0;
  let skipped = 0;
  try {
    for (const user of seedUsers) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, user.email))
        .limit(1);

      if (existing) {
        skipped += 1;
        continue;
      }

      await db.insert(users).values({ ...user, passwordHash });
      created += 1;
    }
  } finally {
    await pool.end();
  }

  console.log(`Seed complete: ${created} created, ${skipped} skipped (already present).`);
  console.log('Sign in with any seeded account, e.g.:');
  for (const user of CANONICAL_USERS) {
    console.log(`  ${user.role.padEnd(8)} ${user.email}  /  ${DEV_PASSWORD}`);
  }
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
