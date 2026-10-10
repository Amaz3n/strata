import { z } from "zod"

import { modelChangesSchema } from "@/lib/drawings/model-options"

export const selectionStatusSchema = z.enum(["pending", "selected", "confirmed", "ordered", "received"])

export const selectionInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  category_id: z.string().uuid("Category is required"),
  status: selectionStatusSchema.default("pending"),
  due_date: z.string().optional(),
  notes: z
    .string()
    .max(1000, "Notes too long")
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : undefined)),
})

export type SelectionInput = z.infer<typeof selectionInputSchema>

export const optionScopeSchema = z.enum(["structural", "design_studio"])

const optionalUuid = z.string().uuid().nullable().optional()
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()

export const catalogCategorySchema = z.object({
  id: optionalUuid,
  communityId: optionalUuid,
  parentCategoryId: optionalUuid,
  name: z.string().trim().min(1).max(120),
  description: optionalText(1000),
  imageUrl: optionalText(2000),
  sortOrder: z.number().int().min(0).max(10000).default(0),
})

export const catalogOptionSchema = z.object({
  id: optionalUuid,
  categoryId: z.string().uuid(),
  communityId: optionalUuid,
  parentOptionId: optionalUuid,
  name: z.string().trim().min(1).max(160),
  description: optionalText(2000),
  optionScope: optionScopeSchema.default("design_studio"),
  priceCents: z.number().int().min(0).nullable().optional(),
  costCents: z.number().int().min(0).nullable().optional(),
  costCodeId: optionalUuid,
  sku: optionalText(120),
  vendor: optionalText(160),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  imageUrl: optionalText(2000),
  /** The uploaded file backing imageUrl, so the object can be traced back. */
  fileId: optionalUuid,
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isAvailable: z.boolean().default(true),
  /**
   * The grade included in base price. A production catalog is standard plus
   * upgrades, so exactly one option per category should carry this; a standard
   * option is always priced at zero and pre-selected on a new home.
   */
  isStandard: z.boolean().default(false),
  /**
   * What the option does to the house in the 3D model. Omitted means "leave
   * the stored changes alone", so a save never clears them by accident.
   */
  modelChanges: modelChangesSchema.optional(),
})

export const catalogPriceSourceSchema = z.object({
  id: z.string().uuid(), price_cents: z.number().int().min(0).max(2147483647),
  is_available: z.boolean(), cost_cents: z.number().int().min(0).max(2147483647).nullable().optional(),
}).strict()

const catalogPriceFields = z
  .object({
    publicationKey: optionalUuid, expectedOrgId: optionalUuid, expectedActorId: optionalUuid,
    expectedPrice: catalogPriceSourceSchema.nullable().optional(),
    optionId: optionalUuid,
    packageId: optionalUuid,
    housePlanVersionId: z.string().uuid(),
    communityId: optionalUuid,
    priceCents: z.number().int().min(0).max(2147483647),
    costCents: z.number().int().min(0).max(2147483647).nullable().optional(),
    isAvailable: z.boolean().default(true),
  })
export const catalogPriceSchema = catalogPriceFields
  .refine((value) => Number(Boolean(value.optionId)) + Number(Boolean(value.packageId)) === 1, {
    message: "Choose exactly one option or package",
  })

export const catalogPackageSourceSchema = z.object({
  id: z.string().uuid(), community_id: z.string().uuid().nullable(),
  name: z.string().min(1).max(160), description: z.string().nullable(), image_url: z.string().nullable(),
  price_cents: z.number().int().min(0).max(2147483647), cost_cents: z.number().int().min(0).max(2147483647).nullable(),
  is_available: z.boolean(), is_archived: z.boolean(), sort_order: z.number().int().min(0).max(10000),
  option_ids: z.array(z.string().uuid()).min(1).max(100).transform(ids => [...ids].sort()),
}).strict()

export const catalogPackageReviewSchema = catalogPackageSourceSchema.omit({ cost_cents: true }).extend({ cost_cents: z.number().int().min(0).max(2147483647).nullable().optional() }).strict()

export const catalogPricePublicationSchema = z.object({
  publicationKey: z.string().uuid(), expectedOrgId: optionalUuid, expectedActorId: optionalUuid,
  communityId: optionalUuid,
  items: z.array(catalogPriceFields.omit({ publicationKey: true, expectedOrgId: true, expectedActorId: true, communityId: true })
    .extend({ expectedPrice: catalogPriceSourceSchema.nullable(), priceCents: z.number().int().min(0).max(2147483647), costCents: z.number().int().min(0).max(2147483647).nullable().optional() })
    .refine((value) => Number(Boolean(value.optionId)) + Number(Boolean(value.packageId)) === 1, { message: "Choose exactly one option or package" }))
    .min(1).max(500).refine(items => new Set(items.map(item => `${(item.optionId ?? item.packageId)?.toLowerCase()}:${item.housePlanVersionId.toLowerCase()}`)).size === items.length, "Choose each price cell only once"),
})

export const packageSchema = z.object({
  requireAtomicPublication: z.boolean().optional(),
  id: optionalUuid,
  publicationKey: optionalUuid,
  expectedOrgId: optionalUuid,
  expectedActorId: optionalUuid,
  expectedPackage: catalogPackageReviewSchema.optional(),
  communityId: optionalUuid,
  name: z.string().trim().min(1).max(160),
  description: optionalText(2000),
  imageUrl: optionalText(2000),
  priceCents: z.number().int().min(0).max(2147483647),
  costCents: z.number().int().min(0).max(2147483647).nullable().optional(),
  isAvailable: z.boolean().default(true),
  isArchived: z.boolean().optional(),
  editArchived: z.literal(true).optional(),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  optionIds: z.array(z.string().uuid()).min(1).max(100).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "Choose each package option only once"),
})

export const catalogGroupSourceSchema = z.object({
  id: z.string().uuid(), community_id: z.string().uuid().nullable(), name: z.string().min(1).max(120),
  schedule_task_key: z.string().min(1).max(160), cutoff_offset_days: z.number().int().min(-365).max(365),
  cutoff_anchor: z.enum(["start", "end"]), sort_order: z.number().int().min(0).max(10000), is_archived: z.boolean(),
  category_ids: z.array(z.string().uuid()).max(100).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "Category references must be unique"),
}).strict()
const categoryVersionSchema = z.object({ id: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), definitionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
export const catalogGroupVersionsSchema = z.array(categoryVersionSchema).max(200).refine(rows => rows.every((row, index) => index === 0 || row.id > rows[index - 1].id), "Reviewed category versions must be unique and ordered")
export const catalogGroupCategoryReviewSchema = z.object({
  id: z.string().uuid(), definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  definition: z.object({ id: z.string().uuid(), community_id: z.string().uuid().nullable(), parent_category_id: z.string().uuid().nullable(),
    name: z.string().max(120).nullable(), description: z.string().max(1000).nullable(), image_url: z.string().max(2000).nullable(),
    sort_order: z.number().int().nullable(), is_archived: z.boolean(),
  }).strict(),
}).strict().refine(row => row.id === row.definition.id, "Category review identity differs")

export const selectionGroupSchema = z.object({
  id: optionalUuid,
  publicationKey: optionalUuid,
  requireAtomicPublication: z.literal(true).optional(),
  expectedGroup: catalogGroupSourceSchema.nullable().optional(),
  expectedCategoryVersions: catalogGroupVersionsSchema.optional(),
  expectedOrgId: optionalUuid,
  expectedActorId: optionalUuid,
  communityId: optionalUuid,
  name: z.string().trim().min(1).max(120),
  scheduleTaskKey: z.string().trim().min(1).max(160),
  cutoffOffsetDays: z.number().int().min(-365).max(365),
  cutoffAnchor: z.enum(["start", "end"]).default("start"),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  categoryIds: z.array(z.string().uuid()).max(100).default([]),
})

export const catalogGroupPublicationSchema = selectionGroupSchema.extend({
  expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid(), publicationKey: z.string().uuid(),
  requireAtomicPublication: z.literal(true), expectedGroup: catalogGroupSourceSchema.nullable(), expectedCategoryVersions: catalogGroupVersionsSchema,
  categoryIds: z.array(z.string().uuid()).max(100).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "Choose each category once").transform(ids => [...ids].sort()),
}).strict().superRefine((value, ctx) => {
  const before = value.expectedGroup
  if (value.id ? !before || before.id.toLowerCase() !== value.id.toLowerCase() || before.is_archived || (before.community_id?.toLowerCase() ?? null) !== (value.communityId?.toLowerCase() ?? null) : before !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Review the original active cutoff rule and preserve its scope", path: ["expectedGroup"] })
  }
  const reviewed = new Set(value.expectedCategoryVersions.map(row => row.id))
  if (value.categoryIds.some(id => !reviewed.has(id.toLowerCase())) || value.categoryIds.length === 0 && reviewed.size !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Original reviewed category versions are required", path: ["expectedCategoryVersions"] })
})
export type CatalogGroupPublicationInput = z.infer<typeof catalogGroupPublicationSchema>

export const cutoffOverrideSchema = z.object({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
  cutoffDate: z.string().date(),
  reason: z.string().trim().min(5).max(500),
})

export const revertCutoffSchema = cutoffOverrideSchema.pick({ projectId: true, groupId: true, reason: true })

export const appointmentSchema = z.object({
  id: optionalUuid,
  communityId: optionalUuid,
  projectId: z.string().uuid(),
  contactId: optionalUuid,
  coordinatorUserId: optionalUuid,
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().int().min(15).max(1440).default(120),
  location: optionalText(500),
  status: z.enum(["scheduled", "completed", "no_show", "canceled"]).default("scheduled"),
  groupIds: z.array(z.string().uuid()).max(50).default([]),
  notes: optionalText(4000),
})

export const postCutoffChangeSchema = z.object({
  projectId: z.string().uuid(),
  changes: z
    .array(
      z
        .object({
          selectionId: z.string().uuid(),
          newOptionId: optionalUuid,
          newPackageId: optionalUuid,
        })
        .refine((value) => Number(Boolean(value.newOptionId)) + Number(Boolean(value.newPackageId)) === 1, {
          message: "Choose exactly one new option or package",
        }),
    )
    .min(1)
    .max(100),
  waiveFee: z.boolean().default(false),
})

export type CatalogCategoryInput = z.infer<typeof catalogCategorySchema>
export type CatalogOptionInput = z.infer<typeof catalogOptionSchema>
export type CatalogPriceInput = z.infer<typeof catalogPriceSchema>
export type SelectionPackageInput = z.infer<typeof packageSchema>
export type SelectionGroupInput = z.infer<typeof selectionGroupSchema>
export type CutoffOverrideInput = z.infer<typeof cutoffOverrideSchema>
export type AppointmentInput = z.infer<typeof appointmentSchema>
export type PostCutoffChangeInput = z.infer<typeof postCutoffChangeSchema>






