import { z } from "zod"

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
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isAvailable: z.boolean().default(true),
})

export const catalogPriceSchema = z
  .object({
    optionId: optionalUuid,
    packageId: optionalUuid,
    housePlanVersionId: z.string().uuid(),
    communityId: optionalUuid,
    priceCents: z.number().int().min(0),
    costCents: z.number().int().min(0).nullable().optional(),
    isAvailable: z.boolean().default(true),
  })
  .refine((value) => Number(Boolean(value.optionId)) + Number(Boolean(value.packageId)) === 1, {
    message: "Choose exactly one option or package",
  })

export const packageSchema = z.object({
  id: optionalUuid,
  communityId: optionalUuid,
  name: z.string().trim().min(1).max(160),
  description: optionalText(2000),
  imageUrl: optionalText(2000),
  priceCents: z.number().int().min(0),
  costCents: z.number().int().min(0).nullable().optional(),
  isAvailable: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  optionIds: z.array(z.string().uuid()).min(1).max(100),
})

export const selectionGroupSchema = z.object({
  id: optionalUuid,
  communityId: optionalUuid,
  name: z.string().trim().min(1).max(120),
  scheduleTaskKey: z.string().trim().min(1).max(160),
  cutoffOffsetDays: z.number().int().min(-365).max(365),
  cutoffAnchor: z.enum(["start", "end"]).default("start"),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  categoryIds: z.array(z.string().uuid()).max(100).default([]),
})

export const cutoffOverrideSchema = z.object({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
  cutoffDate: z.string().date(),
  reason: z.string().trim().min(5).max(500),
})

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







