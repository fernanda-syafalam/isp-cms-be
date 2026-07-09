import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/configuration';
import { WhatsAppTransport } from './whatsapp.transport';

const API_URL = 'https://wa-gateway.test/send';
const API_TOKEN = 'test-wa-token';

function makeTransport(): WhatsAppTransport {
  const configStub = {
    get: (path: string) => {
      const map: Record<string, string> = {
        'app.notifications.wa.apiUrl': API_URL,
        'app.notifications.wa.apiToken': API_TOKEN,
      };
      return map[path];
    },
  } as unknown as ConfigService<{ app: AppConfig }, true>;
  return new WhatsAppTransport(configStub);
}

describe('WhatsAppTransport (ADR-0017, NOTIFICATION_MODE=wa)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the gateway with the token header and returns delivered + providerRef', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ status: true, id: 'wa-msg-1' }), { status: 200 }),
      );

    const transport = makeTransport();
    const result = await transport.send({
      to: '081234567890',
      event: 'due_soon',
      message: 'Halo Budi',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(API_URL);
    expect((init?.headers as Record<string, string>).authorization).toBe(API_TOKEN);
    expect(JSON.parse(init?.body as string)).toEqual({
      target: '081234567890',
      message: 'Halo Budi',
    });
    expect(result).toEqual({ delivered: true, providerRef: 'wa-msg-1' });
  });

  it('returns delivered: false (no throw) when the gateway responds with status: false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: false, reason: 'invalid number' }), { status: 200 }),
    );

    const transport = makeTransport();
    const result = await transport.send({ to: '0812', event: 'overdue', message: 'x' });

    expect(result).toEqual({ delivered: false });
  });

  it('returns delivered: false (no throw) on a non-2xx HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'internal error' }), { status: 500 }),
    );

    const transport = makeTransport();
    const result = await transport.send({ to: '0812', event: 'overdue', message: 'x' });

    expect(result).toEqual({ delivered: false });
  });

  it('returns delivered: false (no throw) when fetch itself rejects (network failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const transport = makeTransport();
    const result = await transport.send({ to: '0812', event: 'overdue', message: 'x' });

    expect(result).toEqual({ delivered: false });
  });
});
