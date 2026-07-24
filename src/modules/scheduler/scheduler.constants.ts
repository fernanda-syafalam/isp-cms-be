import { WIB_TIMEZONE } from '../../common/utils/wib-date';

// The scheduler queue carries only cron-fired trigger jobs; the actual work
// runs in the domain services the processor calls. One shared constant so a
// typo can't silently split producer and consumer onto different queues.
export const SCHEDULER_QUEUE = 'scheduler';

/**
 * TIME-1: the business clock every cron below is written against — WIB
 * (Asia/Jakarta, UTC+7, no DST; see WIB_TIMEZONE). Passed explicitly as
 * BullMQ's `tz` repeat option (bullmq -> cron-parser resolves it via the
 * IANA tz database), so a pattern like isolir's "03:00" fires at 03:00 WIB
 * *regardless of the container's own TZ*. This is deliberately redundant
 * with setting `ENV TZ=Asia/Jakarta` on the container (Dockerfile /
 * docker-compose, layer 1 of TIME-1): that fixes `new Date()`/`Date.now()`
 * app-wide, this fixes cron evaluation even if a future deploy target
 * forgets the container-level TZ.
 */
export const SCHEDULER_TZ = WIB_TIMEZONE;

/**
 * Repeatable job definitions (P2.1). Each `key` is the BullMQ job-scheduler id
 * (idempotent across replicas — re-registering the same key updates in place),
 * `name` is the job name the processor switches on, and `pattern` is a cron
 * expression evaluated against `SCHEDULER_TZ` (WIB) — see that constant's
 * doc for why the timezone is explicit here instead of relying on "the
 * server timezone" (TIME-1: that was the bug — the container ran UTC, so
 * isolir's intended quiet 02:00-03:00 WIB window silently fired at 09:00-
 * 10:00 WIB, in work hours).
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
