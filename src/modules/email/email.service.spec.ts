import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_QUEUE } from './email.constants';
import { EmailService } from './email.service';

describe('EmailService', () => {
  let service: EmailService;
  let queueAdd: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    queueAdd = vi.fn();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: queueAdd } },
      ],
    }).compile();
    service = moduleRef.get(EmailService);
  });

  it('enqueues an order-confirm job with a stable idempotency key', async () => {
    await service.sendOrderConfirmation('order-1', 'a@b.test', { name: 'Alice' });

    expect(queueAdd).toHaveBeenCalledOnce();
    const [name, payload, options] = queueAdd.mock.calls[0] ?? [];
    expect(name).toBe('order-confirm');
    expect(payload).toMatchObject({
      to: 'a@b.test',
      templateId: 'order-confirm',
      idempotencyKey: 'order-confirm:order-1',
    });
    // jobId == idempotencyKey so BullMQ rejects duplicates at insert.
    expect(options).toEqual({ jobId: 'order-confirm:order-1' });
  });
});
