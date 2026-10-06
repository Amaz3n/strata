import { z } from "zod"
import { catalogGroupCategoryReviewSchema } from "@/lib/validation/selections"

const name = z.string().max(200).nullable()
export const catalogPublicationLabelsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), categories: z.array(catalogGroupCategoryReviewSchema).max(200) }).strict(),
  z.object({ kind: z.literal("package"), options: z.array(z.object({ optionId: z.string().uuid(), name }).strict()).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("prices"), items: z.array(z.object({ optionId: z.string().uuid().nullable(), packageId: z.string().uuid().nullable(), housePlanVersionId: z.string().uuid(), subjectName: name, planName: name, versionLabel: name }).strict()).min(1).max(500) }).strict(),
])
export type CatalogPublicationLabels = z.infer<typeof catalogPublicationLabelsSchema>
