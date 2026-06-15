import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Mirror of the FE NodeMetaSchema (src/schemas/topology.ts) — all optional,
// populated per node type. The splitter/portsUsed/portsTotal/coreNo fields are a
// read-time projection of the cabling layer.
const NodeLifecycleSchema = z.enum(['prospek', 'instalasi', 'aktif', 'isolir', 'berhenti']);

export const NodeMetaSchema = z.object({
  ipAddress: z.string().optional(),
  model: z.string().optional(),
  splitter: z.string().optional(),
  portsUsed: z.number().int().nonnegative().optional(),
  portsTotal: z.number().int().positive().optional(),
  rxPowerDbm: z.number().optional(),
  uptimePct: z.number().optional(),
  customerId: z.string().optional(),
  planName: z.string().optional(),
  coreNo: z.number().int().positive().optional(),
  onuSerial: z.string().optional(),
  ponPort: z.string().optional(),
  phone: z.string().optional(),
  lifecycle: NodeLifecycleSchema.optional(),
  maintenance: z.boolean().optional(),
});

export const NetworkNodeResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['olt', 'odc', 'odp', 'pole', 'customer']),
  status: z.enum(['up', 'down', 'unknown']),
  lat: z.number(),
  lng: z.number(),
  parentId: z.string().nullable(),
  meta: NodeMetaSchema.optional(),
});

export const TopologyResponseSchema = z.object({
  items: z.array(NetworkNodeResponseSchema),
  total: z.number().int().nonnegative(),
});

export type NodeMetaResponse = z.infer<typeof NodeMetaSchema>;
export type NetworkNodeResponse = z.infer<typeof NetworkNodeResponseSchema>;
export type TopologyResponse = z.infer<typeof TopologyResponseSchema>;

export class NetworkNodeResponseDto extends createZodDto(NetworkNodeResponseSchema) {}
export class TopologyResponseDto extends createZodDto(TopologyResponseSchema) {}
