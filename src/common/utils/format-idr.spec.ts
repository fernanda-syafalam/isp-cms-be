import { describe, expect, it } from 'vitest';
import { formatIdr } from './format-idr';

describe('formatIdr', () => {
  it('formats a whole-rupiah amount with the Rp prefix and id-ID thousands grouping', () => {
    expect(formatIdr(250_000)).toBe('Rp250.000');
  });

  it('formats zero', () => {
    expect(formatIdr(0)).toBe('Rp0');
  });

  it('formats a large amount', () => {
    expect(formatIdr(1_234_567)).toBe('Rp1.234.567');
  });
});
