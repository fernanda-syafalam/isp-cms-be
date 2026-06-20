// Single source of truth for the queue name. Both the producer
// (NotificationsService.@InjectQueue) and the consumer
// (NotificationsProcessor's @Processor) reference this constant so a typo
// cannot route dunning jobs to /dev/null.
export const NOTIFICATIONS_QUEUE = 'notifications';
