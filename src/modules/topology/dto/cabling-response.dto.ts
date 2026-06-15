import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Mirrors of the FE cabling schemas (src/schemas/{cable,closure,splitter,circuit}.ts).
// The OSP physical layer is the source of truth; topology node meta is a
// read-time projection of it. These response shapes are the wire contract.

export const LatLngSchema = z.object({ lat: z.number(), lng: z.number() });

// --- Cable + Strand -------------------------------------------------------
export const CableKindSchema = z.enum(['feeder', 'distribution', 'drop']);
export const CableStatusSchema = z.enum(['planned', 'installed', 'retired']);

export const CableResponseSchema = z.object({
  id: z.string().min(1),
  kind: CableKindSchema,
  spec: z.string().min(1),
  fiberCount: z.number().int().positive(),
  tubeCount: z.number().int().positive(),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  route: z.array(LatLngSchema),
  lengthM: z.number().nonnegative(),
  status: CableStatusSchema,
  installedAt: z.iso.datetime().nullable(),
});

export const StrandStatusSchema = z.enum(['allocated', 'reserved', 'dead']);
export const StrandResponseSchema = z.object({
  id: z.string().min(1),
  cableId: z.string().min(1),
  tubeNo: z.number().int().positive(),
  coreNo: z.number().int().min(1).max(12),
  status: StrandStatusSchema,
  circuitId: z.string().min(1).nullable(),
  customerId: z.string().min(1).nullable(),
});

// --- Splitter -------------------------------------------------------------
export const SplitterRatioSchema = z.enum(['1:2', '1:4', '1:8', '1:16', '1:32', '1:64']);
export const SplitterPortSchema = z.object({
  portNo: z.number().int().positive(),
  outNodeId: z.string().min(1).nullable(),
  customerId: z.string().min(1).nullable(),
  strandId: z.string().min(1).nullable(),
});
export const SplitterResponseSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  ratio: SplitterRatioSchema,
  inCableId: z.string().min(1).nullable(),
  inStrandId: z.string().min(1).nullable(),
  ports: z.array(SplitterPortSchema),
});

// --- Closure + Splice -----------------------------------------------------
export const ClosureTypeSchema = z.enum(['odc', 'odp', 'joint', 'inline']);
export const ClosureResponseSchema = z.object({
  id: z.string().min(1),
  type: ClosureTypeSchema,
  nodeId: z.string().min(1),
  trayCapacity: z.number().int().positive(),
  fiberCapacity: z.number().int().positive(),
});

export const SpliceTypeSchema = z.enum(['fusion', 'mechanical', 'passthrough']);
export const SpliceResponseSchema = z.object({
  id: z.string().min(1),
  closureId: z.string().min(1),
  inCableId: z.string().min(1),
  inTubeNo: z.number().int().positive(),
  inCoreNo: z.number().int().min(1).max(12),
  outCableId: z.string().min(1),
  outTubeNo: z.number().int().positive(),
  outCoreNo: z.number().int().min(1).max(12),
  type: SpliceTypeSchema,
  lossDb: z.number().nonnegative(),
});

// --- Circuit --------------------------------------------------------------
export const CircuitStatusSchema = z.enum(['active', 'planned', 'down']);
export const CircuitResponseSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  customerNodeId: z.string().min(1),
  oltNodeId: z.string().min(1),
  oltPonPort: z.string().min(1),
  onuSerial: z.string().min(1).nullable(),
  status: CircuitStatusSchema,
});

// --- List wrappers --------------------------------------------------------
export const CableListResponseSchema = z.object({
  items: z.array(CableResponseSchema),
  total: z.number().int().nonnegative(),
});
export const StrandListResponseSchema = z.object({
  items: z.array(StrandResponseSchema),
  total: z.number().int().nonnegative(),
});
export const SplitterListResponseSchema = z.object({
  items: z.array(SplitterResponseSchema),
  total: z.number().int().nonnegative(),
});
export const ClosureListResponseSchema = z.object({
  items: z.array(ClosureResponseSchema),
  total: z.number().int().nonnegative(),
});
export const SpliceListResponseSchema = z.object({
  items: z.array(SpliceResponseSchema),
  total: z.number().int().nonnegative(),
});
export const CircuitListResponseSchema = z.object({
  items: z.array(CircuitResponseSchema),
  total: z.number().int().nonnegative(),
});

export type CableResponse = z.infer<typeof CableResponseSchema>;
export type StrandResponse = z.infer<typeof StrandResponseSchema>;
export type SplitterResponse = z.infer<typeof SplitterResponseSchema>;
export type ClosureResponse = z.infer<typeof ClosureResponseSchema>;
export type SpliceResponse = z.infer<typeof SpliceResponseSchema>;
export type CircuitResponse = z.infer<typeof CircuitResponseSchema>;

export class CableListResponseDto extends createZodDto(CableListResponseSchema) {}
export class StrandListResponseDto extends createZodDto(StrandListResponseSchema) {}
export class SplitterListResponseDto extends createZodDto(SplitterListResponseSchema) {}
export class ClosureListResponseDto extends createZodDto(ClosureListResponseSchema) {}
export class SpliceListResponseDto extends createZodDto(SpliceListResponseSchema) {}
export class CircuitListResponseDto extends createZodDto(CircuitListResponseSchema) {}
