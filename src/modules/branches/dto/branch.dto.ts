import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/branches. */
export const CreateBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(80),
    manager: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(20),
  })
  .strict();

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export class CreateBranchDto extends createZodDto(CreateBranchSchema) {}

/** Input for PATCH /v1/branches/:id (status enables deactivation). */
export const UpdateBranchSchema = CreateBranchSchema.partial()
  .extend({ status: z.enum(['active', 'inactive']).optional() })
  .strict();

export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export class UpdateBranchDto extends createZodDto(UpdateBranchSchema) {}

/** Output shape for a branch. */
export const BranchResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  city: z.string(),
  manager: z.string(),
  phone: z.string(),
  status: z.enum(['active', 'inactive']),
  isHeadOffice: z.boolean(),
  customerCount: z.number().int().nonnegative(),
  mrr: z.number().int().nonnegative(),
  deviceCount: z.number().int().nonnegative(),
});

export type BranchResponse = z.infer<typeof BranchResponseSchema>;
export class BranchResponseDto extends createZodDto(BranchResponseSchema) {}

/**
 * Full-set summary aggregate for the branches list.
 * Computed over ALL branches — NEVER affected by q/status/paging.
 *
 * - branches: total branch count.
 * - customers: sum of customer_count across all branches.
 * - mrr: sum of mrr across all branches (whole IDR).
 */
export const BranchSummarySchema = z.object({
  branches: z.number().int().nonnegative(),
  customers: z.number().int().nonnegative(),
  mrr: z.number().int().nonnegative(),
});

export type BranchSummaryResponse = z.infer<typeof BranchSummarySchema>;

/**
 * Paginated list response for GET /v1/branches.
 *
 * - `items`   – current page (after status + q filter, sort, limit/offset).
 * - `total`   – count matching status+q filter BEFORE paging (drives page count).
 * - `summary` – full-set aggregate; NEVER affected by status/q/paging.
 */
export const BranchListResponseSchema = z.object({
  items: z.array(BranchResponseSchema),
  total: z.number().int().nonnegative(),
  summary: BranchSummarySchema,
});

export type BranchListResponse = z.infer<typeof BranchListResponseSchema>;
export class BranchListResponseDto extends createZodDto(BranchListResponseSchema) {}
