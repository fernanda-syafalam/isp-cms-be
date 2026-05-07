import { Injectable, Logger } from '@nestjs/common';

export interface SendEmailRequest {
  to: string;
  templateId: string;
  variables: Record<string, string>;
}

export interface SendEmailResult {
  messageId: string;
}

/**
 * Outbound email port. The boilerplate ships with a logging stub —
 * production deployments swap this provider for a real SES / SendGrid /
 * Mailgun / Resend adapter. Keep the interface narrow so swapping does
 * not ripple into every caller.
 */
export abstract class EmailGateway {
  abstract send(req: SendEmailRequest): Promise<SendEmailResult>;
}

@Injectable()
export class LoggingEmailGateway extends EmailGateway {
  private readonly logger = new Logger(LoggingEmailGateway.name);

  async send(req: SendEmailRequest): Promise<SendEmailResult> {
    const messageId = `local-${Date.now()}`;
    this.logger.log(
      { to: req.to, templateId: req.templateId, messageId },
      'email gateway: pretending to send',
    );
    return { messageId };
  }
}
