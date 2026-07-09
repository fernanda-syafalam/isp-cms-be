import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogTransport } from './log.transport';

describe('LogTransport (NOTIFICATION_MODE=log, default)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always reports delivered without making an external call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = new LogTransport();

    const result = await transport.send({ to: '0812', event: 'due_soon', message: 'Halo Budi' });

    expect(result).toEqual({ delivered: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
