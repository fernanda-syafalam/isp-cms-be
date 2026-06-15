import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/onboarding — end-to-end subscriber onboarding. Mirrors
 * the FE `OnboardingSchema`: profile + service area + chosen plan + the
 * install schedule. On success the backend creates the customer (status
 * `instalasi`) and a linked install work order.
 *
 * `note`, `lat` and `lng` are accepted for contract parity but not persisted
 * in this iteration: `note` is an install hint with no column, and lat/lng
 * place the customer's node on the topology map (a Phase C concern). `email`
 * accepts '' as "no email" (normalised to null in the service).
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
    lat: z.number().optional(),
    lng: z.number().optional(),
  })
  .strict();

export type OnboardCustomerInput = z.infer<typeof OnboardCustomerSchema>;

export class OnboardCustomerDto extends createZodDto(OnboardCustomerSchema) {}
