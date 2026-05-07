import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { EmailGateway } from './email.gateway';
import { EmailProcessor } from './email.processor';
import type { SendEmailJob } from './email.service';

function fakeJob(data: SendEmailJob): Job<SendEmailJob> {
  return { id: 'j-1', data, attemptsMade: 0 } as unknown as Job<SendEmailJob>;
}

describe('EmailProcessor', () => {
  it('delegates to the gateway and returns its messageId', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'm-1' });
    const gateway: Pick<EmailGateway, 'send'> = { send };
    const processor = new EmailProcessor(gateway as EmailGateway);

    const result = await processor.process(
      fakeJob({
        to: 'a@b.test',
        templateId: 'order-confirm',
        variables: { x: '1' },
        idempotencyKey: 'order-confirm:1',
      }),
    );

    expect(result).toEqual({ messageId: 'm-1' });
    expect(send).toHaveBeenCalledWith({
      to: 'a@b.test',
      templateId: 'order-confirm',
      variables: { x: '1' },
    });
  });

  it('propagates gateway errors so BullMQ can retry', async () => {
    const send = vi.fn().mockRejectedValue(new Error('SMTP down'));
    const gateway: Pick<EmailGateway, 'send'> = { send };
    const processor = new EmailProcessor(gateway as EmailGateway);

    await expect(
      processor.process(
        fakeJob({
          to: 'a@b.test',
          templateId: 'order-confirm',
          variables: {},
          idempotencyKey: 'order-confirm:2',
        }),
      ),
    ).rejects.toThrow('SMTP down');
  });
});
