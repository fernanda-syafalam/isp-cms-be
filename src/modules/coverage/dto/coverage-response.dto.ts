import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a coverage area / POP. */
export const CoverageResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['pop', 'area']),
  region: z.string(),
  capacity: z.number().int().nonnegative(),
  activeConnections: z.number().int().nonnegative(),
  status: z.enum(['operational', 'maintenance', 'down']),
});

export type CoverageResponse = z.infer<typeof CoverageResponseSchema>;

export class CoverageResponseDto extends createZodDto(CoverageResponseSchema) {}
