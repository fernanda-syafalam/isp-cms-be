import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Honest first-run setup checklist (P3.E.2). Every `done` flag is derived
 * from a real count read at request time — none of it is faked from an
 * unrelated proxy signal (the bug this replaces: the FE used to treat
 * `routerCount > 0` as "profiles & pools configured").
 */
export const SetupStatusSchema = z.object({
  catalogue: z.object({
    done: z.boolean(),
    plansCount: z.number().int().nonnegative(),
  }),
  // `done` requires a router AND at least one profile AND at least one pool —
  // the three are provisioned independently, so a router alone proves nothing.
  network: z.object({
    done: z.boolean(),
    routersCount: z.number().int().nonnegative(),
    profilesCount: z.number().int().nonnegative(),
    poolsCount: z.number().int().nonnegative(),
  }),
  branches: z.object({
    done: z.boolean(),
    branchesCount: z.number().int().nonnegative(),
  }),
  // The settings row always exists (seeded with defaults on first read), so
  // this reports the configured company name rather than row existence.
  settings: z.object({
    done: z.boolean(),
    companyName: z.string(),
  }),
  // "> 1" on purpose: the bootstrap admin alone must not read as "staff
  // configured" — there has to be at least one more admin/staff account.
  staff: z.object({
    done: z.boolean(),
    staffCount: z.number().int().nonnegative(),
  }),
  onboarding: z.object({
    done: z.boolean(),
    instalasiCount: z.number().int().nonnegative(),
    aktifCount: z.number().int().nonnegative(),
  }),
  workOrders: z.object({
    done: z.boolean(),
    installDoneCount: z.number().int().nonnegative(),
  }),
  active: z.object({
    done: z.boolean(),
    activeCount: z.number().int().nonnegative(),
  }),
});

export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export class SetupStatusDto extends createZodDto(SetupStatusSchema) {}
