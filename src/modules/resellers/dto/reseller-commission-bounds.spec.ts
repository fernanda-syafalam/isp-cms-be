import { describe, expect, it } from 'vitest';
import { CreateResellerSchema } from './create-reseller.dto';
import { UpdateResellerSchema } from './update-reseller.dto';

// DB-4: commission_pct is numeric(6,5) (max 9.99999) and a commission is a
// fraction 0..1 (ADR-0010). The DTOs must reject a >1 value at validation
// (400) so it never reaches the DB as a numeric-overflow 500.
describe('reseller commissionPct bounds (DB-4)', () => {
  const base = { name: 'Mitra A', area: 'Bandung' };

  it('CreateResellerSchema accepts a valid fraction', () => {
    const r = CreateResellerSchema.safeParse({ ...base, commissionPct: 0.05 });
    expect(r.success).toBe(true);
  });

  it('CreateResellerSchema accepts the 1.0 (100%) upper bound', () => {
    expect(CreateResellerSchema.safeParse({ ...base, commissionPct: 1 }).success).toBe(true);
  });

  it('CreateResellerSchema rejects a >1 fraction (was 500 numeric overflow)', () => {
    // Both the old permissive .max(100) input and any value inside the old
    // range but above the numeric(6,5) ceiling must now be a validation error.
    expect(CreateResellerSchema.safeParse({ ...base, commissionPct: 5 }).success).toBe(false);
    expect(CreateResellerSchema.safeParse({ ...base, commissionPct: 50 }).success).toBe(false);
  });

  it('UpdateResellerSchema rejects a >1 fraction', () => {
    expect(UpdateResellerSchema.safeParse({ commissionPct: 10 }).success).toBe(false);
  });

  it('UpdateResellerSchema accepts a valid fraction', () => {
    expect(UpdateResellerSchema.safeParse({ commissionPct: 0.075 }).success).toBe(true);
  });
});
