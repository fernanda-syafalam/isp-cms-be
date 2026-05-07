// Single source of truth for the queue name. Both the producer
// (EmailService.@InjectQueue) and the consumer (EmailProcessor's
// @Processor) reference this constant so a typo cannot route jobs to
// /dev/null.
export const EMAIL_QUEUE = 'email';
