// The scheduler queue carries only cron-fired trigger jobs; the actual work
// runs in the domain services the processor calls. One shared constant so a
// typo can't silently split producer and consumer onto different queues.
export const SCHEDULER_QUEUE = 'scheduler';

/**
 * Repeatable job definitions (P2.1). Each `key` is the BullMQ job-scheduler id
 * (idempotent across replicas — re-registering the same key updates in place),
 * `name` is the job name the processor switches on, and `pattern` is a cron
 * expression evaluated in the server timezone.
 */
export const SCHEDULER_JOBS = {
  billingRun: { key: 'billing.run', name: 'billing.run', pattern: '0 2 1 * *' },
  billingIsolirOverdue: {
    key: 'billing.isolir-overdue',
    name: 'billing.isolir-overdue',
    pattern: '0 3 * * *',
  },
  billingDunning: { key: 'billing.dunning', name: 'billing.dunning', pattern: '0 8 * * *' },
  ticketsSlaScan: { key: 'tickets.sla-scan', name: 'tickets.sla-scan', pattern: '*/15 * * * *' },
  paymentIntentsExpireSweep: {
    key: 'payment-intents.expire-sweep',
    name: 'payment-intents.expire-sweep',
    pattern: '0 * * * *',
  },
} as const;

export type SchedulerJobName = (typeof SCHEDULER_JOBS)[keyof typeof SCHEDULER_JOBS]['name'];
