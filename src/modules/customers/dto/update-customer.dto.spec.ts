import { describe, expect, it } from 'vitest';
import { UpdateCustomerSchema } from './update-customer.dto';

const PLAN_ID = '0b1e6f5a-3c1d-4e5a-8b1a-2f3c4d5e6f70';

describe('UpdateCustomerSchema', () => {
  it('rejects planId so PATCH cannot change a plan (use change-plan)', () => {
    const result = UpdateCustomerSchema.safeParse({ planId: PLAN_ID, phone: '080000000000' });
    expect(result.success).toBe(false);
  });

  it('still accepts the editable profile fields', () => {
    const parsed = UpdateCustomerSchema.parse({ fullName: 'Budi' });
    expect(parsed).toEqual({ fullName: 'Budi' });
  });

  it('rejects resellerId (resellers are out of the MVP; strict schema)', () => {
    const result = UpdateCustomerSchema.safeParse({ resellerId: null });
    expect(result.success).toBe(false);
  });
});
