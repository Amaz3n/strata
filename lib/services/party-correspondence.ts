/**
 * One directory party's message log, across every project.
 *
 * `lib/services/project-email-ingest.ts` answers "what mail does this project
 * hold"; this answers "what mail have we exchanged with this person or
 * company", which is the question the directory has never been able to answer.
 * It reads the same `project_emails` rows through the same vocabulary
 * (`lib/correspondence.ts`) — only the axis changes.
 *
 * Read-only by design. Filing, classifying and linking a message all stay on
 * the project's correspondence workbench, which is the one home for those
 * mutations; every row here deep-links back to it.
 */

import {
  isCorrespondenceClassification,
  type CorrespondenceClassification,
  type CorrespondenceClassifiedBy,
  type CorrespondenceDirection,
} from "@/lib/correspondence"
import type { PartyKind } from "@/lib/directory/roles"
import { getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

/** Newest N messages the party log renders; the UI says when it truncates. */
export const PARTY_CORRESPONDENCE_LIMIT = 50

/** A caller may ask for more, but not for an unbounded page. */
const PARTY_CORRESPONDENCE_MAX_LIMIT = 200

const EMAIL_SELECT = `
  id, project_id, direction, from_address, to_addresses, subject,
  classification, classified_by, received_at, sent_at, created_at,
  project:projects(name)
`

interface PartyEmailRow {
  id: string
  project_id: string
  direction: string
  from_address: string | null
  to_addresses: string[] | null
  subject: string | null
  classification: string | null
  classified_by: string | null
  received_at: string | null
  sent_at: string | null
  created_at: string
  project: { name: string | null } | { name: string | null }[] | null
}

export interface PartyCorrespondenceRow {
  id: string
  project_id: string
  project_name: string
  direction: CorrespondenceDirection
  subject: string
  /** The address on the far side of the message from the builder. */
  counterparty_address: string
  classification: CorrespondenceClassification
  classified_by: CorrespondenceClassifiedBy
  /** When the message was written, else when Arc filed it. */
  occurred_at: string
  /** Opens this message in its project's correspondence log. */
  href: string
}

export interface PartyCorrespondenceList {
  rows: PartyCorrespondenceRow[]
  limit: number
  truncated: boolean
}

/**
 * PostgREST returns a to-one embed as an object, but emits an array when it
 * cannot prove the relationship is singular. Accept both.
 */
function firstRelated<T>(value: T | T[] | null): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/**
 * The same rule the ingest backfill uses to attribute a message: an inbound
 * message came *from* the party, an outbound one went *to* them.
 */
function counterpartyAddress(row: PartyEmailRow, direction: CorrespondenceDirection): string {
  if (direction === "inbound") return row.from_address ?? ""
  return row.to_addresses?.[0] ?? ""
}

function mapRow(row: PartyEmailRow): PartyCorrespondenceRow {
  const direction: CorrespondenceDirection = row.direction === "outbound" ? "outbound" : "inbound"
  const classification = String(row.classification ?? "general")
  const project = firstRelated(row.project)
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: project?.name ?? "Unknown project",
    direction,
    subject: row.subject?.trim() || "(No subject)",
    counterparty_address: counterpartyAddress(row, direction),
    classification: isCorrespondenceClassification(classification) ? classification : "general",
    classified_by: row.classified_by === "ai" ? "ai" : "user",
    occurred_at: row.sent_at ?? row.received_at ?? row.created_at,
    href: `/projects/${row.project_id}/correspondence?email=${row.id}`,
  }
}

export async function listPartyCorrespondence(input: {
  kind: PartyKind
  partyId: string
  limit?: number
  orgId?: string
}): Promise<PartyCorrespondenceList> {
  const { supabase, orgId, userId } = await requireOrgContext(input.orgId)
  // Gated on the data's own permission rather than the directory's: reaching
  // these rows from a party page must not be a cheaper route to project mail
  // than the project's own log, whose RLS policy checks this same key.
  await requirePermission("correspondence.read", { supabase, orgId, userId })

  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? PARTY_CORRESPONDENCE_LIMIT)),
    PARTY_CORRESPONDENCE_MAX_LIMIT,
  )

  // Division scope is the enforcement layer for cross-project reads: a
  // division-scoped user sees this party's mail from their divisions only.
  const scopedProjectIds = await getDivisionScopedProjectIds({ orgId, userId, supabase })
  if (scopedProjectIds?.length === 0) return { rows: [], limit, truncated: false }

  let query = supabase
    .from("project_emails")
    .select(EMAIL_SELECT)
    .eq("org_id", orgId)
    .eq(input.kind === "company" ? "company_id" : "contact_id", input.partyId)
    // Same ordering key as the project log: `received_at` is always stamped,
    // so it totally orders the page, while `sent_at` can be null.
    .order("received_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    // One past the cap so the UI can say the list is truncated instead of
    // quietly presenting a partial record as the whole log.
    .limit(limit + 1)

  if (scopedProjectIds) query = query.in("project_id", scopedProjectIds)

  const { data, error } = await query
  if (error) throw new Error(`Failed to load party correspondence: ${error.message}`)

  const all = (data as PartyEmailRow[] | null) ?? []
  const truncated = all.length > limit
  return {
    rows: (truncated ? all.slice(0, limit) : all).map(mapRow),
    limit,
    truncated,
  }
}
