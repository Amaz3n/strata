import { z } from "zod"

export const accountingConnectionLabelSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
})

const dimensionValueSchema = z.object({ id: z.string().min(1).max(255), name: z.string().max(255).nullable() })

export const accountingEntityMapSchema = z.object({
  id: z.string().uuid().optional(),
  connectionId: z.string().uuid(),
  divisionId: z.string().uuid().nullable().optional(),
  communityId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dimensions: z.record(z.enum(["class", "customer", "location", "department", "entity"]), dimensionValueSchema),
  acknowledgeResync: z.boolean().optional(),
})
