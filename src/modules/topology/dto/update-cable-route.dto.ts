import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Request body for PATCH /v1/cables/:id — replace a cable's surveyed route. The
// server recomputes lengthM from the polyline. At least the two endpoints are
// required. Mirrors the FE UpdateCableRouteSchema.
const LatLngSchema = z.object({ lat: z.number(), lng: z.number() });

export const UpdateCableRouteSchema = z.object({
  route: z.array(LatLngSchema).min(2),
});

export type UpdateCableRouteInput = z.infer<typeof UpdateCableRouteSchema>;

export class UpdateCableRouteDto extends createZodDto(UpdateCableRouteSchema) {}
