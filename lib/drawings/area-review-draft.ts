import { z } from "zod"
import {
  acceptedAreaSchema,
  areaBoundarySchema,
  areaRegionSchema,
  areaPointSchema,
} from "@/lib/validation/area-takeoff"

// Browser drafts are untrusted. Acceptance still validates against the current
// revision, permissions, scale and saved geometry on the server.
const proposalSchema = acceptedAreaSchema.and(
  z.object({
    areaSqft: z.number().finite().nonnegative(),
    warnings: z.array(z.string().max(2000)).max(100),
  }),
)
export const areaReviewDraftSchema = z.object({
  version: z.literal(2),
  proposals: z.array(proposalSchema).max(200),
  region: areaRegionSchema.nullable(),
  boundaries: z.array(areaBoundarySchema).max(100),
  finishPolicy: z.enum(["drawn", "include-fixtures"]),
  warnings: z.array(z.string().max(2000)).max(500),
  coverage: z
    .object({
      labels: z
        .array(
          z.object({
            label: z.string().max(500),
            point: areaPointSchema,
            status: z.enum(["covered", "shared-zone", "unresolved"]),
            proposalIds: z.array(z.string().max(2000)).max(200),
          }),
        )
        .max(2000),
    })
    .nullable(),
  assigned: z.record(z.array(z.string().max(100_000)).max(1000)),
  selected: z.array(z.string().max(2000)).max(200),
  finishScopeNote: z.string().max(500),
})
