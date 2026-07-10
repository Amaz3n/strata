import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  sendEmail,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  escapeHtml,
} from "@/lib/services/mailer"
import { fetchCompanyContacts } from "@/lib/services/portal-links"
import { distributeRevisionInputSchema, type DistributeRevisionInput } from "@/lib/validation/drawings"

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

// Cap the sheet-number list in the email body; the portal shows the full set.
const MAX_LISTED_SHEETS = 20

export interface RevisionDistributionRecipient {
  token_id: string
  portal_type: "client" | "sub"
  contact_id: string | null
  company_id: string | null
  name: string | null
  company_name: string | null
  email: string
  /** Portal-level open tracking (portal_access_tokens.last_accessed_at). */
  last_accessed_at: string | null
  access_count: number
}

export interface RevisionDistributionRecord {
  sent_at: string
  sent_by_name: string | null
  recipient_count: number
}

export interface RevisionRecipientList {
  recipients: RevisionDistributionRecipient[]
  last_distribution: RevisionDistributionRecord | null
}

interface RevisionRow {
  id: string
  project_id: string
  drawing_set_id: string | null
  revision_label: string
  issued_date: string | null
  status: string | null
}

async function loadPublishedRevision(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  revisionId: string,
): Promise<RevisionRow> {
  const { data, error } = await supabase
    .from("drawing_revisions")
    .select("id, project_id, drawing_set_id, revision_label, issued_date, status")
    .eq("org_id", orgId)
    .eq("id", revisionId)
    .maybeSingle()
  if (error || !data) {
    throw new Error(`Revision not found${error ? `: ${error.message}` : ""}`)
  }
  return data as RevisionRow
}

/**
 * Active portal tokens for the revision's project that can see drawings
 * (can_view_documents), resolved to email recipients. Contact tokens resolve
 * to the contact's email; company tokens fan out to the company's contacts.
 * Tokens without a reachable email are omitted — there is nobody to notify.
 */
async function resolveEligibleRecipients(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  projectId: string,
): Promise<RevisionDistributionRecipient[]> {
  const { data: tokens, error } = await supabase
    .from("portal_access_tokens")
    .select(
      "id, portal_type, contact_id, company_id, last_accessed_at, access_count, expires_at, max_access_count, created_at",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("can_view_documents", true)
    .in("portal_type", ["client", "sub"])
    .is("revoked_at", null)
    .is("paused_at", null)
    .is("scoped_rfi_id", null)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load portal tokens: ${error.message}`)
  }

  const now = Date.now()
  const active = (tokens ?? []).filter((row) => {
    if (row.expires_at && Date.parse(row.expires_at) <= now) return false
    if (row.max_access_count && (row.access_count ?? 0) >= row.max_access_count) return false
    return row.contact_id || row.company_id
  })
  if (active.length === 0) return []

  const contactIds = [...new Set(active.map((t) => t.contact_id).filter(Boolean))] as string[]
  const companyIds = [...new Set(active.map((t) => t.company_id).filter(Boolean))] as string[]

  interface ContactRow {
    id: string
    full_name: string | null
    email: string | null
  }
  interface CompanyRow {
    id: string
    name: string
  }

  const [contactsResult, companiesResult, companyContactsEntries] = await Promise.all([
    contactIds.length
      ? supabase
          .from("contacts")
          .select("id, full_name, email")
          .eq("org_id", orgId)
          .in("id", contactIds)
      : Promise.resolve({ data: [] as ContactRow[] }),
    companyIds.length
      ? supabase.from("companies").select("id, name").eq("org_id", orgId).in("id", companyIds)
      : Promise.resolve({ data: [] as CompanyRow[] }),
    Promise.all(
      companyIds.map(async (companyId) => ({
        companyId,
        contacts: await fetchCompanyContacts(supabase, orgId, companyId),
      })),
    ),
  ])

  const contactById = new Map<string, ContactRow>(
    ((contactsResult.data ?? []) as ContactRow[]).map((c) => [c.id, c]),
  )
  const companyNameById = new Map<string, string>(
    ((companiesResult.data ?? []) as CompanyRow[]).map((c) => [c.id, c.name]),
  )
  const contactsByCompanyId = new Map(companyContactsEntries.map((e) => [e.companyId, e.contacts]))

  // Dedupe by email; contact-scoped tokens win over company fan-out so opens
  // attribute to the most specific link. Tokens are newest-first already.
  const byEmail = new Map<string, RevisionDistributionRecipient>()
  const push = (recipient: RevisionDistributionRecipient, preferred: boolean) => {
    const key = recipient.email.toLowerCase()
    const existing = byEmail.get(key)
    if (!existing || (preferred && !existing.contact_id)) {
      byEmail.set(key, recipient)
    }
  }

  for (const token of active) {
    const base = {
      token_id: token.id as string,
      portal_type: token.portal_type as "client" | "sub",
      contact_id: (token.contact_id as string | null) ?? null,
      company_id: (token.company_id as string | null) ?? null,
      company_name: token.company_id ? companyNameById.get(token.company_id as string) ?? null : null,
      last_accessed_at: (token.last_accessed_at as string | null) ?? null,
      access_count: (token.access_count as number | null) ?? 0,
    }
    if (token.contact_id) {
      const contact = contactById.get(token.contact_id as string)
      if (contact?.email) {
        push({ ...base, name: contact.full_name ?? null, email: contact.email as string }, true)
      }
      continue
    }
    if (token.company_id) {
      for (const contact of contactsByCompanyId.get(token.company_id as string) ?? []) {
        if (contact.email) {
          push({ ...base, contact_id: contact.id, name: contact.full_name ?? null, email: contact.email }, false)
        }
      }
    }
  }

  return [...byEmail.values()].sort((a, b) => {
    if (a.portal_type !== b.portal_type) return a.portal_type === "client" ? -1 : 1
    return (a.name ?? a.email).localeCompare(b.name ?? b.email)
  })
}

async function loadLastDistribution(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  revisionId: string,
): Promise<RevisionDistributionRecord | null> {
  const { data, error } = await supabase
    .from("events")
    .select("created_at, payload")
    .eq("org_id", orgId)
    .eq("event_type", "drawing_revision_distributed")
    .eq("entity_id", revisionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const payload = (data.payload ?? {}) as Record<string, unknown>
  return {
    sent_at: data.created_at as string,
    sent_by_name: typeof payload.sent_by_name === "string" ? payload.sent_by_name : null,
    recipient_count: typeof payload.recipient_count === "number" ? payload.recipient_count : 0,
  }
}

/**
 * Recipients eligible to be notified about a published revision, plus the most
 * recent distribution (if any) so the UI can show "Sent to N on <date>".
 */
export async function listRevisionRecipients(
  revisionId: string,
  orgId?: string,
): Promise<RevisionRecipientList> {
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const revision = await loadPublishedRevision(supabase, resolvedOrgId, revisionId)
  await requireProjectPermission(userId, revision.project_id, "drawing.read")

  const [recipients, lastDistribution] = await Promise.all([
    resolveEligibleRecipients(supabase, resolvedOrgId, revision.project_id),
    loadLastDistribution(supabase, resolvedOrgId, revisionId),
  ])

  return { recipients, last_distribution: lastDistribution }
}

interface ChangedSheetSummary {
  added: Array<{ sheet_number: string; sheet_title: string | null }>
  updated: Array<{ sheet_number: string; sheet_title: string | null }>
}

/**
 * What this (published) revision changed: sheets whose only version came from
 * this revision were added by it; the rest received a new version.
 */
async function summarizeRevisionChanges(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  revisionId: string,
): Promise<ChangedSheetSummary> {
  const { data: versions, error } = await supabase
    .from("drawing_sheet_versions")
    .select("drawing_sheet_id, drawing_sheets!inner(id, sheet_number, sheet_title, sort_order)")
    .eq("org_id", orgId)
    .eq("drawing_revision_id", revisionId)
  if (error) {
    throw new Error(`Failed to load revision sheets: ${error.message}`)
  }

  const sheets = new Map<string, { sheet_number: string; sheet_title: string | null; sort_order: number }>()
  for (const row of versions ?? []) {
    const sheet = row.drawing_sheets as unknown as {
      id: string
      sheet_number: string
      sheet_title: string | null
      sort_order: number | null
    }
    sheets.set(sheet.id, {
      sheet_number: sheet.sheet_number,
      sheet_title: sheet.sheet_title ?? null,
      sort_order: sheet.sort_order ?? 0,
    })
  }
  if (sheets.size === 0) return { added: [], updated: [] }

  const { data: allVersions, error: countError } = await supabase
    .from("drawing_sheet_versions")
    .select("drawing_sheet_id")
    .eq("org_id", orgId)
    .in("drawing_sheet_id", [...sheets.keys()])
  if (countError) {
    throw new Error(`Failed to load sheet version counts: ${countError.message}`)
  }
  const versionCounts = new Map<string, number>()
  for (const row of allVersions ?? []) {
    const id = row.drawing_sheet_id as string
    versionCounts.set(id, (versionCounts.get(id) ?? 0) + 1)
  }

  const added: ChangedSheetSummary["added"] = []
  const updated: ChangedSheetSummary["updated"] = []
  const ordered = [...sheets.entries()].sort(
    (a, b) => a[1].sort_order - b[1].sort_order || a[1].sheet_number.localeCompare(b[1].sheet_number),
  )
  for (const [sheetId, sheet] of ordered) {
    const entry = { sheet_number: sheet.sheet_number, sheet_title: sheet.sheet_title }
    if ((versionCounts.get(sheetId) ?? 1) <= 1) added.push(entry)
    else updated.push(entry)
  }
  return { added, updated }
}

function formatIssuedDate(value: string | null): string {
  const date = value ? new Date(value) : new Date()
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function buildSheetListHtml(summary: ChangedSheetSummary): string {
  const changed = [...summary.updated.map((s) => ({ ...s, kind: "Updated" })), ...summary.added.map((s) => ({ ...s, kind: "New" }))]
  if (changed.length === 0) return ""
  const shown = changed.slice(0, MAX_LISTED_SHEETS)
  const remainder = changed.length - shown.length
  const rows = shown
    .map(
      (sheet) => `
        <tr>
          <td style="padding: 3px 12px 3px 0; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #111111; white-space: nowrap;">${escapeHtml(sheet.sheet_number)}</td>
          <td style="padding: 3px 12px 3px 0; font-size: 12px; color: #2f2f2f;">${escapeHtml(sheet.sheet_title ?? "")}</td>
          <td style="padding: 3px 0; font-size: 11px; color: #6b6b6b; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;">${sheet.kind}</td>
        </tr>`,
    )
    .join("")
  return `
    <table border="0" cellpadding="0" cellspacing="0" style="margin: 14px 0; border-collapse: collapse;">
      ${rows}
    </table>
    ${remainder > 0 ? `<p style="margin: 0 0 14px 0; color: #6b6b6b; font-size: 12px;">+ ${remainder} more sheet${remainder === 1 ? "" : "s"} — see the portal for the full set.</p>` : ""}
  `
}

export interface DistributeRevisionResult {
  sent: number
  failed: number
}

/**
 * Email a published revision to selected portal recipients: which sheets
 * changed plus a deep link into their portal, and record the send (event +
 * audit) so the GC can prove the current set was distributed.
 */
export async function distributeRevision(
  input: DistributeRevisionInput,
  orgId?: string,
): Promise<DistributeRevisionResult> {
  const parsed = distributeRevisionInputSchema.parse(input)
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const revision = await loadPublishedRevision(supabase, resolvedOrgId, parsed.revision_id)
  // Mirror publishRevision's capability: distributing a set is part of issuing it.
  await requireProjectPermission(userId, revision.project_id, "drawing.upload")
  if (revision.status !== "published") {
    throw new Error("Only published revisions can be distributed")
  }

  const eligible = await resolveEligibleRecipients(supabase, resolvedOrgId, revision.project_id)
  const requested = new Set(parsed.token_ids)
  const seenEmails = new Set<string>()
  const recipients = eligible.filter((recipient) => {
    if (!requested.has(recipient.token_id)) return false
    const key = recipient.email.toLowerCase()
    if (seenEmails.has(key)) return false
    seenEmails.add(key)
    return true
  })
  if (recipients.length === 0) {
    throw new Error("None of the selected recipients are eligible for this project")
  }

  const [summary, { data: projectRow }, { data: org }, { data: sender }, tokenRows] = await Promise.all([
    summarizeRevisionChanges(supabase, resolvedOrgId, parsed.revision_id),
    supabase.from("projects").select("name").eq("org_id", resolvedOrgId).eq("id", revision.project_id).maybeSingle(),
    supabase.from("orgs").select("name, logo_url, slug").eq("id", resolvedOrgId).maybeSingle(),
    supabase.from("app_users").select("full_name").eq("id", userId).maybeSingle(),
    supabase
      .from("portal_access_tokens")
      .select("id, token")
      .eq("org_id", resolvedOrgId)
      .in("id", [...new Set(recipients.map((r) => r.token_id))]),
  ])
  const tokenValueById = new Map(((tokenRows.data ?? []) as Array<{ id: string; token: string }>).map((t) => [t.id, t.token]))

  const projectName = projectRow?.name ?? "your project"
  const issuedDate = formatIssuedDate(revision.issued_date)
  const changedCount = summary.added.length + summary.updated.length
  const countsLine = [
    summary.updated.length > 0 ? `${summary.updated.length} sheet${summary.updated.length === 1 ? "" : "s"} updated` : null,
    summary.added.length > 0 ? `${summary.added.length} new sheet${summary.added.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(", ")
  const sheetListHtml = buildSheetListHtml(summary)
  const noteHtml = parsed.message
    ? `<p style="margin: 0 0 14px 0; padding: 10px 12px; background-color: #f5f5f3; border-left: 3px solid #dcdcdc; color: #2f2f2f;">${escapeHtml(parsed.message)}</p>`
    : ""
  const subject = `Drawings updated: ${projectName} — ${revision.revision_label}`

  const sendResults = await Promise.all(
    recipients.map(async (recipient) => {
      const tokenValue = tokenValueById.get(recipient.token_id)
      if (!tokenValue) return { recipient, sent: false }
      const portalLink = `${APP_URL}/${recipient.portal_type === "client" ? "p" : "s"}/${tokenValue}`
      const greeting = recipient.name ? `<p style="margin: 0 0 14px 0;">Hi ${escapeHtml(recipient.name)},</p>` : ""
      const html = renderStandardEmailLayout({
        title: `Drawing issuance: ${revision.revision_label}`,
        messageHtml: `
          ${greeting}
          <p style="margin: 0 0 14px 0;">${escapeHtml(org?.name ?? "Arc")} issued <strong>${escapeHtml(revision.revision_label)}</strong> for <strong>${escapeHtml(projectName)}</strong> on ${escapeHtml(issuedDate)}.</p>
          ${changedCount > 0 ? `<p style="margin: 0 0 4px 0;">${escapeHtml(countsLine)}:</p>` : ""}
          ${sheetListHtml}
          ${noteHtml}
          <p style="margin: 0;">Open your project portal to review the current drawing set. Superseded sheets are no longer current — please work from this issuance.</p>
        `,
        buttonText: "View drawings",
        buttonUrl: portalLink,
        orgName: org?.name,
        orgLogoUrl: org?.logo_url,
        showManageSettings: false,
      })
      const sent = await sendEmail({
        to: [recipient.email],
        subject,
        html,
        from: getOrgSenderEmail(org?.slug, org?.name),
      })
      return { recipient, sent }
    }),
  )

  const sent = sendResults.filter((r) => r.sent).length
  const failed = sendResults.length - sent
  if (sent === 0) {
    throw new Error("No emails could be sent — check the email configuration and try again")
  }

  const recipientRecords = sendResults.map(({ recipient, sent: delivered }) => ({
    token_id: recipient.token_id,
    contact_id: recipient.contact_id,
    company_id: recipient.company_id,
    email: recipient.email,
    portal_type: recipient.portal_type,
    sent: delivered,
  }))

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "drawing_revision_distributed",
    entityType: "drawing_revision",
    entityId: parsed.revision_id,
    payload: {
      project_id: revision.project_id,
      drawing_set_id: revision.drawing_set_id,
      revision_label: revision.revision_label,
      recipient_count: sent,
      failed_count: failed,
      updated_count: summary.updated.length,
      added_count: summary.added.length,
      sent_by_name: sender?.full_name ?? null,
      recipients: recipientRecords,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_revision",
    entityId: parsed.revision_id,
    after: {
      distributed_at: new Date().toISOString(),
      revision_label: revision.revision_label,
      recipient_count: sent,
      recipients: recipientRecords,
    },
  })

  return { sent, failed }
}
