import { z } from "zod";

const positive = z.number().finite().positive();
const index = z.number().int().nonnegative();
const bounds = z.object({x0:z.number().finite().min(0).max(1),y0:z.number().finite().min(0).max(1),x1:z.number().finite().min(0).max(1.00001),y1:z.number().finite().min(0).max(1.00001)})
  .refine(b=>b.x1>b.x0&&b.y1>b.y0,'Schedule evidence must have nonempty source bounds');
const cell = z.object({text:z.string().min(1).max(4000),runIndices:z.array(index).min(1).max(200),bounds});
export const windowScheduleRowSchema = z.object({
  sourceId:z.string().min(1).max(250),pageNumber:index.min(1).optional(),titleRunIndex:index,
  headerRunIndices:z.array(index).min(1).max(200),mark:z.string().min(1).max(12),
  cells:z.object({mark:cell,width:cell.nullable(),height:cell.nullable(),type:cell.nullable(),quantity:cell.nullable(),notes:cell.nullable(),sizeBasis:cell.nullable(),transom:cell.nullable(),transomSize:cell.nullable(),headReference:cell.nullable()}),
  scheduledWidthFt:positive.nullable(),scheduledHeightFt:positive.nullable(),
  dimensionBasis:z.enum(['unit-size','rough-opening','unspecified']),quantity:positive.int().nullable(),issues:z.array(z.string().max(500)).max(50),
});
const tag = z.object({mark:z.string().min(1).max(12),runIndex:index,pathId:index,bounds});
export const windowScheduleAssociationSchema = z.object({
  openingId:z.string().min(1),planSourceId:z.string().min(1).max(250),status:z.enum(['proposed','ambiguous','unmatched','stale']),reason:z.string().min(1).max(1000),
  candidates:z.array(z.object({tag,schedule:windowScheduleRowSchema})).max(2000),
});
export const unmatchedWindowScheduleTagSchema = z.object({
  planSourceId:z.string().min(1).max(250),tag,schedules:z.array(windowScheduleRowSchema).max(2000),
});
