import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Provisioning snapshot. Mirrors CustomerConnection on the schema.
const ConnectionResponseSchema = z.object({
  type: z.enum(['pppoe', 'gpon']),
  pppoeUsername: z.string(),
  profile: z.string(),
  ipAddress: z.string(),
  onuSerial: z.string().nullable(),
  olt: z.string().nullable(),
  ponPort: z.string().nullable(),
  rxPower: z.number().nullable(),
});

/**
 * Output shape for a customer. `planName` is joined from the plans table
 * (not stored). `areaId`/`areaName`/`resellerName`/`connection` are
 * nullable: the area, reseller and provisioning data is owned by modules
 * that do not exist yet, so a customer created today carries nulls there
 * until those modules populate them. `@ZodSerializerDto` strips anything
 * not declared here.
 */
export const CustomerResponseSchema = z.object({
  id: z.uuid(),
  customerNo: z.string(),
  fullName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  address: z.string(),
  areaId: z.uuid().nullable(),
  areaName: z.string().nullable(),
  planId: z.uuid(),
  planName: z.string(),
  status: z.enum(['prospek', 'instalasi', 'aktif', 'isolir', 'berhenti']),
  // Why the customer is held (P3.A.3): overdue vs voluntary (cuti); null when not held.
  holdReason: z.enum(['overdue', 'voluntary']).nullable(),
  outstanding: z.number().int().nonnegative(),
  // Optional (not just nullable): a mitra's KYC-safe projection (ADR-0010
  // amendment / ADR-0015, SEC-4) omits these keys entirely rather than
  // sending them as null — admin/staff responses always include them.
  npwp: z.string().nullable().optional(),
  ktp: z.string().nullable().optional(),
  consentAt: z.iso.datetime().nullable(),
  resellerName: z.string().nullable(),
  connection: ConnectionResponseSchema.nullable(),
  joinedAt: z.iso.datetime(),
});

export type CustomerResponse = z.infer<typeof CustomerResponseSchema>;

export class CustomerResponseDto extends createZodDto(CustomerResponseSchema) {}

/**
 * Full-set lifecycle-status + outstanding rollup for the customer list.
 * Computed over the caller's ACCESS SCOPE (area / resellerId — the same
 * server-side scoping `list()` already applies, including the mitra
 * resellerId override, ADR-0010) — but NEVER affected by the status/q
 * filter or paging (mirrors the work-orders/invoices summary aggregate, FE
 * contract parity). `outstanding` is the sum of `customers.outstanding`
 * across that same scope. Every status key is always present (zero-filled).
 */
export const CustomerSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  outstanding: z.number().int().nonnegative(),
  byStatus: z.object({
    prospek: z.number().int().nonnegative(),
    instalasi: z.number().int().nonnegative(),
    aktif: z.number().int().nonnegative(),
    isolir: z.number().int().nonnegative(),
    berhenti: z.number().int().nonnegative(),
  }),
});

export type CustomerSummary = z.infer<typeof CustomerSummarySchema>;

/**
 * Paginated list response for GET /v1/customers.
 *
 * - `items`   – current page (after status/q/area filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – scope-wide aggregate (area/resellerId scoping applies, status/q
 *   does not); never affected by paging.
 */
export const CustomerListResponseSchema = z.object({
  items: z.array(CustomerResponseSchema),
  total: z.number().int().nonnegative(),
  summary: CustomerSummarySchema,
});

export type CustomerListResponse = z.infer<typeof CustomerListResponseSchema>;

export class CustomerListResponseDto extends createZodDto(CustomerListResponseSchema) {}
