import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { SendNotificationInput } from './dto/send-notification.dto';
import { NotificationsProcessor } from './notifications.processor';
import type { NotificationsService } from './notifications.service';

describe('NotificationsProcessor', () => {
  it('delivers the job by calling NotificationsService.send', async () => {
    const send = vi.fn();
    const processor = new NotificationsProcessor({ send } as unknown as NotificationsService);
    const data: SendNotificationInput = { event: 'overdue', to: '0812' };

    await processor.process({ id: 'j1', data } as Job<SendNotificationInput>);

    expect(send).toHaveBeenCalledWith(data);
  });
});
