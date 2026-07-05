import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/onboarding — end-to-end subscriber onboarding. Mirrors
 * the FE `OnboardingSchema`: profile + service area + chosen plan + the
 * install schedule. On success the backend creates the customer (status
 * `instalasi`) and a linked install work order.
 *
 * `lat`/`lng` are the map pin captured at onboarding (persisted for coverage +
 * the topology map, P3.A.1). `odpId` is the FTTH distribution point chosen for
 * this drop — when present, onboarding reserves a port on it atomically before
 * creating the customer. `ktp`/`npwp`/`consent` are the KYC + UU-PDP consent
 * captured in the wizard. `note` is an install hint with no column (not
 * persisted). `email` accepts '' as "no email" (normalised to null in the
 * service).
 */
export const OnboardCustomerSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(6).max(20),
    email: z.union([z.email().max(255), z.literal('')]),
    address: z.string().trim().min(1).max(255),
    areaName: z.string().trim().min(1).max(120),
    planId: z.uuid(),
    technician: z.string().trim().min(1).max(120),
    // The FE schedules the install with a date picker (YYYY-MM-DD).
    scheduledAt: z.iso.date(),
    note: z.string().trim().max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    odpId: z.string().max(60).optional(),
    // KYC (UU PDP): identity numbers + explicit data-processing consent.
    ktp: z.string().trim().max(32).optional(),
    npwp: z.string().trim().max(40).optional(),
    consent: z.boolean().optional(),
  })
  .strict();

export type OnboardCustomerInput = z.infer<typeof OnboardCustomerSchema>;

export class OnboardCustomerDto extends createZodDto(OnboardCustomerSchema) {}
