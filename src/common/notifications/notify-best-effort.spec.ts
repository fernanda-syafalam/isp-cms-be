import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { notifyBestEffort } from './notify-best-effort';

describe('notifyBestEffort', () => {
  it('runs fn and never rejects when fn resolves', async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const fn = vi.fn().mockResolvedValue(undefined);

    await expect(notifyBestEffort(logger, fn, { id: '1' })).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs and swallows when fn rejects, never rethrows', async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const err = new Error('queue down');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(notifyBestEffort(logger, fn, { id: '1' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ id: '1', err }, 'notification enqueue failed');
  });

  it('uses the caller-supplied message when given', async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);

    await notifyBestEffort(
      logger,
      fn,
      { ticketId: 't1', status: 'resolved' },
      'ticket_update notification enqueue failed',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      { ticketId: 't1', status: 'resolved', err },
      'ticket_update notification enqueue failed',
    );
  });
});
