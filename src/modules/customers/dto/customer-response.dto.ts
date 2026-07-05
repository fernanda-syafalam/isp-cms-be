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
  npwp: z.string().nullable(),
  ktp: z.string().nullable(),
  consentAt: z.iso.datetime().nullable(),
  resellerName: z.string().nullable(),
  connection: ConnectionResponseSchema.nullable(),
  joinedAt: z.iso.datetime(),
});

export type CustomerResponse = z.infer<typeof CustomerResponseSchema>;

export class CustomerResponseDto extends createZodDto(CustomerResponseSchema) {}
