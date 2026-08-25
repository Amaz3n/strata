import { z } from "zod"

import {
  CORRESPONDENCE_CLASSIFICATIONS,
  LINKABLE_ENTITY_TYPES,
} from "@/lib/correspondence"

/** Threads a single page of the log renders. */
export const CORRESPONDENCE_PAGE_SIZE = 50

/** Ceiling on one request, so a hand-built query can't ask for the whole log. */
export const CORRESPONDENCE_MAX_PAGE_SIZE = 200

export const correspondenceFilterSchema = z.object({
  projectId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  /** Only threads carrying a message no person has ruled on. */
  needsReview: z.boolean().optional(),
  linked: z.enum(["linked", "unlinked"]).optional(),
  hasAttachments: z.boolean().optional(),
  /** Inclusive, on the thread's most recent message. */
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(1).max(CORRESPONDENCE_MAX_PAGE_SIZE).default(CORRESPONDENCE_PAGE_SIZE),
})

export const archivedCorrespondenceFilterSchema = z.object({
  projectId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(1).max(CORRESPONDENCE_MAX_PAGE_SIZE).default(CORRESPONDENCE_PAGE_SIZE),
})

export const projectScopeSchema = z.object({ projectId: z.string().uuid() })

export const emailScopeSchema = projectScopeSchema.extend({ emailId: z.string().uuid() })

export const threadScopeSchema = projectScopeSchema.extend({ threadId: z.string().min(1).max(200) })

/**
 * What a bulk action applies to.
 *
 * The list is a list of conversations but the ruling is per message, so a
 * selection is either the messages themselves (from a thread sheet) or the
 * threads that contain them (from the list). Bulk by construction: one id is
 * the single-row case, not a separate code path.
 */
const selectionFields = {
  emailIds: z.array(z.string().uuid()).max(200).default([]),
  threadIds: z.array(z.string().min(1).max(200)).max(200).default([]),
}

const NOTHING_SELECTED = { message: "Select at least one message.", path: ["emailIds"] }

function hasSelection(value: { emailIds: string[]; threadIds: string[] }) {
  return value.emailIds.length > 0 || value.threadIds.length > 0
}

export const selectionSchema = projectScopeSchema.extend(selectionFields).refine(hasSelection, NOTHING_SELECTED)

export const reclassifySchema = projectScopeSchema
  .extend({ ...selectionFields, classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS) })
  .refine(hasSelection, NOTHING_SELECTED)

/** Ratifies whatever the model guessed, without changing it. */
export const confirmClassificationSchema = selectionSchema

export const archiveSchema = projectScopeSchema
  .extend({ ...selectionFields, archived: z.boolean() })
  .refine(hasSelection, NOTHING_SELECTED)

export const linkSchema = emailScopeSchema.extend({
  entityType: z.enum(LINKABLE_ENTITY_TYPES),
  entityId: z.string().uuid(),
})

export const unlinkSchema = emailScopeSchema.extend({ linkId: z.string().uuid() })

export const linkTargetSearchSchema = projectScopeSchema.extend({
  entityType: z.enum(LINKABLE_ENTITY_TYPES),
  search: z.string().trim().max(120).optional(),
})

export type CorrespondenceFilterInput = z.infer<typeof correspondenceFilterSchema>
export type ArchivedCorrespondenceFilterInput = z.infer<typeof archivedCorrespondenceFilterSchema>
export type CorrespondenceSelection = z.input<typeof selectionSchema>
export type ReclassifyInput = z.input<typeof reclassifySchema>
export type ArchiveInput = z.input<typeof archiveSchema>
export type LinkCorrespondenceInput = z.infer<typeof linkSchema>

/**
 * URL state → filters, dropping anything that is not a value this log knows.
 *
 * The filters live in the query string so a filtered view can be linked and
 * exported; a stale or hand-typed parameter must degrade to "no filter" rather
 * than throwing the page.
 */
export function parseCorrespondenceSearchParams(
  projectId: string,
  params: Record<string, string | string[] | undefined>,
): CorrespondenceFilterInput {
  const value = (key: string) => {
    const raw = params[key]
    const single = Array.isArray(raw) ? raw[0] : raw
    return single?.trim() || undefined
  }
  const candidate = {
    projectId,
    search: value("q"),
    classification: value("classification"),
    direction: value("direction"),
    needsReview: value("review") === "1" ? true : undefined,
    linked: value("linked"),
    hasAttachments: value("attachments") === "1" ? true : undefined,
    from: value("from"),
    to: value("to"),
    page: Number(value("page") ?? 1),
    pageSize: CORRESPONDENCE_PAGE_SIZE,
  }
  const parsed = correspondenceFilterSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // One bad parameter should not discard the rest of the view.
  const cleaned: Record<string, unknown> = { ...candidate }
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if (typeof key === "string") delete cleaned[key]
  }
  return correspondenceFilterSchema.parse({ ...cleaned, projectId, pageSize: CORRESPONDENCE_PAGE_SIZE })
}
