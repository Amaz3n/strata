import { recordEvent } from "@/lib/services/events"
import { findExistingCompanyPortalToken } from "@/lib/services/portal-access"
import {
  buildComplianceAutopilotSubject,
  sendComplianceAutopilotEmail,
} from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { expireProjectOwnComplianceDocuments } from "@/lib/services/project-own-compliance"
import { expirePrequalificationsWithClient } from "@/lib/services/prequalification"

const appBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When to speak up before a document lapses, as a fraction of the type's own
 * warning window. A type configured for 30 days is chased at 30, 14 and 3; one
 * configured for 90 is chased at 90, 42 and 9. `expiry_warning_days` was stored,
 * validated and described to the user, and until now read by nothing.
 */
function expiryReminderDays(warningDays: number): number[] {
  const window = warningDays > 0 ? warningDays : 30
  return Array.from(
    new Set([window, Math.round(window * 0.45), Math.max(1, Math.round(window * 0.1))]),
  ).sort((a, b) => b - a)
}

/**
 * Once a document is actually expired the fixed weekly bucket meant a vendor
 * who ignored the run-up was chased once and then left alone. These are days
 * past expiry at which the chase repeats, escalating in tone.
 */
const OVERDUE_ESCALATION_DAYS = [1, 7, 14, 30, 60]

type ReminderKind = "missing" | "expiring" | "expired" | "rejected" | "escalation"

interface OrgRow {
  id: string
  name?: string | null
  logo_url?: string | null
  slug?: string | null
}

interface RequirementRow {
  id: string
  org_id: string
  company_id: string
  document_type_id: string
  is_required: boolean
  companies?: {
    id: string
    name: string
    email?: string | null
  } | null
  compliance_document_types?: {
    id: string
    name: string
    code: string
    has_expiry: boolean
    expiry_warning_days?: number | null
  } | null
}

interface ComplianceDocumentRow {
  id: string
  company_id: string
  document_type_id: string
  status: string
  expiry_date?: string | null
  rejection_reason?: string | null
  revoked_at?: string | null
  superseded_by_id?: string | null
  created_at: string
}

interface WaiverRow {
  company_id: string
  document_type_id: string
  expires_at?: string | null
  revoked_at?: string | null
}

interface ContactRow {
  id: string
  primary_company_id?: string | null
  full_name: string
  email?: string | null
}

interface PendingGroup {
  companyName: string
  recipientEmail: string
  recipientName: string | null
  items: Array<{
    deliveryId: string
    documentName: string
    reminderKind: "missing" | "expiring" | "expired" | "rejected"
    expiryDate: string | null
    rejectionReason: string | null
  }>
}

export interface ComplianceAutopilotMetrics {
  orgs: number
  requirements: number
  remindersCreated: number
  /** Reminder rows sent. One email can cover several. */
  sent: number
  /** Emails actually sent — one per vendor per run. */
  emails: number
  skipped: number
  failed: number
  digests: number
  prequalificationsExpired: number
}

function utcDateOnly(value: Date | string) {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function daysUntil(date: string, today: Date) {
  return Math.floor((utcDateOnly(date) - utcDateOnly(today)) / DAY_MS)
}

function weekKey(date: Date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const current = utcDateOnly(date)
  const week = Math.floor((current - start) / (7 * DAY_MS)) + 1
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * The document currently answering each requirement.
 *
 * Withdrawn and superseded submissions are dropped first: taking the newest row
 * regardless meant a revoked certificate silently suppressed the chase for the
 * requirement it no longer satisfies, and a rejected-but-superseded one chased
 * a vendor for paperwork they had already replaced.
 */
function latestDocumentsByCompanyAndType(rows: ComplianceDocumentRow[]) {
  const latest = new Map<string, ComplianceDocumentRow>()
  for (const row of rows) {
    if (row.revoked_at || row.superseded_by_id) continue
    const key = `${row.company_id}:${row.document_type_id}`
    const current = latest.get(key)
    if (!current || new Date(row.created_at) > new Date(current.created_at)) {
      latest.set(key, row)
    }
  }
  return latest
}

function hasActiveWaiver(waivers: WaiverRow[], today: Date) {
  return waivers.some((waiver) => {
    if (waiver.revoked_at) return false
    if (!waiver.expires_at) return true
    return daysUntil(waiver.expires_at, today) >= 0
  })
}

function recipientForCompany(company: RequirementRow["companies"], contacts: ContactRow[]) {
  const companyEmail = company?.email?.trim()
  if (companyEmail) {
    return { email: companyEmail, name: company?.name ?? null, contactId: null }
  }

  const contact = contacts.find((row) => row.email?.trim())
  return contact?.email
    ? { email: contact.email.trim(), name: contact.full_name, contactId: contact.id }
    : null
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function buildReminder({
  requirement,
  document,
  today,
}: {
  requirement: RequirementRow
  document?: ComplianceDocumentRow
  today: Date
}): {
  kind: ReminderKind
  bucket: string
  days?: number | null
  expiryDate?: string | null
  rejectionReason?: string | null
} | null {
  const docType = requirement.compliance_document_types
  if (!docType) return null

  if (!document) {
    const bucket = `missing:${weekKey(today)}`
    return { kind: "missing", bucket, days: null, expiryDate: null }
  }

  if (document.status === "pending_review") {
    return null
  }

  // A rejection used to produce no chase at all: the vendor was told nothing
  // and the autopilot only knew missing and expiring, so a returned certificate
  // was invisible from both sides until someone opened the portal.
  if (document.status === "rejected") {
    return {
      kind: "rejected",
      bucket: `rejected:${document.id}:${weekKey(today)}`,
      days: null,
      expiryDate: document.expiry_date ?? null,
      rejectionReason: document.rejection_reason ?? null,
    }
  }

  if (document.status !== "approved") {
    const bucket = `missing:${weekKey(today)}`
    return { kind: "missing", bucket, days: null, expiryDate: document.expiry_date ?? null }
  }

  if (!docType.has_expiry || !document.expiry_date) return null

  const days = daysUntil(document.expiry_date, today)
  if (days < 0) {
    // Escalate on a schedule rather than once per calendar week, so ignoring
    // the run-up no longer buys silence.
    const daysOverdue = Math.abs(days)
    const step = OVERDUE_ESCALATION_DAYS.filter((mark) => mark <= daysOverdue).pop()
    if (step === undefined) return null
    return {
      kind: daysOverdue >= 14 ? "escalation" : "expired",
      bucket: `expired:${step}:${document.expiry_date}`,
      days,
      expiryDate: document.expiry_date,
    }
  }
  if (expiryReminderDays(docType.expiry_warning_days ?? 30).includes(days)) {
    return {
      kind: "expiring",
      bucket: `expiring:${days}:${document.expiry_date}`,
      days,
      expiryDate: document.expiry_date,
    }
  }
  return null
}

/**
 * Every standing requirement explicitly assigned to a vendor.
 *
 * Project overlays are deliberately not applied here: a chase email is about
 * the vendor's standing relationship with the builder, not about one job, and
 * a vendor cannot act on "this is required on Maple Street" from an inbox.
 * Org defaults are configuration templates, not automatic enrollment.
 */
async function resolveOrgRequirementRows(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
): Promise<RequirementRow[]> {
  const companyRowsResult = await supabase
    .from("company_compliance_requirements")
    .select(
      `
      id, org_id, company_id, document_type_id, is_required,
      companies(id, name, email),
      compliance_document_types(id, name, code, has_expiry, expiry_warning_days)
    `,
    )
    .eq("org_id", orgId)
    .eq("is_required", true)

  if (companyRowsResult.error) throw companyRowsResult.error

  return ((companyRowsResult.data ?? []) as unknown as Array<
    Omit<RequirementRow, "companies" | "compliance_document_types"> & {
      companies?: RequirementRow["companies"] | RequirementRow["companies"][]
      compliance_document_types?:
        | RequirementRow["compliance_document_types"]
        | RequirementRow["compliance_document_types"][]
    }
  >).map((row) => ({
    ...row,
    companies: firstRelation(row.companies),
    compliance_document_types: firstRelation(row.compliance_document_types),
  }))
}

async function createDeliveryIfNeeded(args: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  runId: string
  requirement: RequirementRow
  document?: ComplianceDocumentRow
  reminder: NonNullable<ReturnType<typeof buildReminder>>
  recipient: ReturnType<typeof recipientForCompany>
  /** Keys already delivered for this org, loaded once per run. */
  alreadyDelivered: Set<string>
}) {
  const idempotencyKey = [
    "compliance",
    args.reminder.kind,
    args.requirement.company_id,
    args.requirement.document_type_id,
    args.reminder.bucket,
  ].join(":")

  // Checked against a set loaded once per org rather than a query per
  // requirement. Now that org defaults are resolved per vendor, a mid-sized
  // builder can reach several hundred requirements in a run, and this used to
  // be a sequential round-trip for every one of them.
  if (args.alreadyDelivered.has(idempotencyKey)) return null
  args.alreadyDelivered.add(idempotencyKey)

  const docType = args.requirement.compliance_document_types
  const company = args.requirement.companies
  const { data, error } = await args.supabase
    .from("compliance_autopilot_deliveries")
    .insert({
      org_id: args.orgId,
      run_id: args.runId,
      company_id: args.requirement.company_id,
      contact_id: args.recipient?.contactId ?? null,
      document_type_id: args.requirement.document_type_id,
      requirement_id: args.requirement.id,
      document_id: args.document?.id ?? null,
      reminder_kind: args.reminder.kind,
      reminder_bucket: args.reminder.bucket,
      recipient_email: args.recipient?.email ?? null,
      recipient_name: args.recipient?.name ?? null,
      subject: docType ? `${docType.name} ${args.reminder.kind}` : args.reminder.kind,
      status: args.recipient?.email ? "queued" : "skipped",
      idempotency_key: idempotencyKey,
      payload: {
        company_name: company?.name ?? null,
        document_name: docType?.name ?? null,
        expiry_date: args.reminder.expiryDate ?? null,
        days_until_expiry: args.reminder.days ?? null,
      },
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create compliance delivery: ${error?.message ?? "Unknown error"}`)
  }

  return data.id as string
}

export async function runComplianceAutopilot(): Promise<ComplianceAutopilotMetrics> {
  const supabase = createServiceSupabaseClient()
  const today = new Date()
  const metrics: ComplianceAutopilotMetrics = {
    orgs: 0,
    requirements: 0,
    remindersCreated: 0,
    sent: 0,
    emails: 0,
    skipped: 0,
    failed: 0,
    digests: 0,
    prequalificationsExpired: 0,
  }

  const { data: orgs, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, logo_url, slug")
    .eq("status", "active")

  if (orgError) {
    throw new Error(`Failed to load orgs for compliance autopilot: ${orgError.message}`)
  }

  for (const org of ((orgs ?? []) as OrgRow[])) {
    metrics.orgs += 1
    const { data: run, error: runError } = await supabase
      .from("compliance_autopilot_runs")
      .insert({ org_id: org.id, status: "running" })
      .select("id")
      .single()

    if (runError || !run) {
      metrics.failed += 1
      continue
    }

    try {
      metrics.prequalificationsExpired += await expirePrequalificationsWithClient(
        supabase,
        org.id,
        today.toISOString().slice(0, 10),
      )
      const ownDocumentsExpired = await expireProjectOwnComplianceDocuments(
        supabase,
        org.id,
        today.toISOString().slice(0, 10),
      )
      if (ownDocumentsExpired > 0) {
        await recordEvent({
          orgId: org.id,
          eventType: "project_own_compliance_expired",
          entityType: "compliance",
          entityId: org.id,
          channel: "notification",
          payload: { count: ownDocumentsExpired },
        }).catch(() => null)
      }
      const requirementRows = await resolveOrgRequirementRows(supabase, org.id)
      metrics.requirements += requirementRows.length
      const companyIds = Array.from(new Set(requirementRows.map((row) => row.company_id)))

      if (companyIds.length === 0) {
        await supabase
          .from("compliance_autopilot_runs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            metrics: {
              requirements: 0,
              issues: { missing: 0, expiring: 0, expired: 0, rejected: 0, escalation: 0 },
            },
          })
          .eq("id", run.id)
        continue
      }

      const [documentsResult, waiversResult, contactsResult] = await Promise.all([
        supabase
          .from("compliance_documents")
          .select(
            "id, company_id, document_type_id, status, expiry_date, rejection_reason, revoked_at, superseded_by_id, created_at",
          )
          .eq("org_id", org.id)
          .in("company_id", companyIds),
        supabase
          .from("company_compliance_requirement_waivers")
          .select("company_id, document_type_id, expires_at, revoked_at")
          .eq("org_id", org.id)
          .in("company_id", companyIds),
        supabase
          .from("contacts")
          .select("id, primary_company_id, full_name, email")
          .eq("org_id", org.id)
          .in("primary_company_id", companyIds),
      ])

      const firstLoadError =
        documentsResult.error || waiversResult.error || contactsResult.error
      if (firstLoadError) throw firstLoadError

      const latestDocuments = latestDocumentsByCompanyAndType(
        (documentsResult.data ?? []) as ComplianceDocumentRow[],
      )
      const waiversByKey = new Map<string, WaiverRow[]>()
      for (const waiver of ((waiversResult.data ?? []) as WaiverRow[])) {
        const key = `${waiver.company_id}:${waiver.document_type_id}`
        waiversByKey.set(key, [...(waiversByKey.get(key) ?? []), waiver])
      }
      const contactsByCompany = new Map<string, ContactRow[]>()
      for (const contact of ((contactsResult.data ?? []) as ContactRow[])) {
        if (!contact.primary_company_id) continue
        contactsByCompany.set(contact.primary_company_id, [
          ...(contactsByCompany.get(contact.primary_company_id) ?? []),
          contact,
        ])
      }

      // Every reminder this org has already sent, in one read. The per-vendor
      // check that replaced it was a round-trip per requirement, and resolving
      // org defaults multiplies requirements by the whole vendor list.
      const { data: deliveredRows } = await supabase
        .from("compliance_autopilot_deliveries")
        .select("idempotency_key")
        .eq("org_id", org.id)
      const alreadyDelivered = new Set(
        (deliveredRows ?? []).map((row: { idempotency_key: string }) => row.idempotency_key),
      )

      const issueCounts: Record<ReminderKind, number> = {
        missing: 0,
        expiring: 0,
        expired: 0,
        rejected: 0,
        escalation: 0,
      }
      const pendingByCompany = new Map<string, PendingGroup>()

      for (const requirement of requirementRows) {
        const key = `${requirement.company_id}:${requirement.document_type_id}`
        if (hasActiveWaiver(waiversByKey.get(key) ?? [], today)) continue

        const document = latestDocuments.get(key)
        const reminder = buildReminder({ requirement, document, today })
        if (!reminder) continue

        issueCounts[reminder.kind] += 1
        const recipient = recipientForCompany(
          requirement.companies,
          contactsByCompany.get(requirement.company_id) ?? [],
        )
        const deliveryId = await createDeliveryIfNeeded({
          supabase,
          orgId: org.id,
          runId: run.id,
          requirement,
          document,
          reminder,
          recipient,
          alreadyDelivered,
        })

        if (!deliveryId) continue
        metrics.remindersCreated += 1

        // The builder side of the same reminder. `compliance_document_expiring`
        // is on the email allowlist and a user can switch it on in settings, so
        // it has to actually be emitted — the vendor being chased is no use to
        // the person who has to stop paying them.
        if (reminder.kind === "expiring" || reminder.kind === "escalation") {
          await recordEvent({
            orgId: org.id,
            eventType: "compliance_document_expiring",
            entityType: "company",
            entityId: requirement.company_id,
            channel: "notification",
            payload: {
              company_id: requirement.company_id,
              company_name: requirement.companies?.name ?? null,
              document_name: requirement.compliance_document_types?.name ?? null,
              document_type_id: requirement.document_type_id,
              expiry_date: reminder.expiryDate ?? null,
              days_until_expiry: reminder.days ?? null,
              blocks_payment: reminder.kind === "escalation",
            },
          }).catch(() => null)
        }

        if (!recipient?.email || !requirement.compliance_document_types || !requirement.companies) {
          metrics.skipped += 1
          continue
        }

        const group = pendingByCompany.get(requirement.company_id) ?? {
          companyName: requirement.companies.name,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          items: [],
        }
        group.items.push({
          deliveryId,
          documentName: requirement.compliance_document_types.name,
          // An escalation is still an expired document to the vendor reading
          // the email; the distinction is in how often we say it, not in what
          // they have to do about it.
          reminderKind: reminder.kind === "escalation" ? "expired" : reminder.kind,
          expiryDate: reminder.expiryDate ?? null,
          rejectionReason: reminder.rejectionReason ?? null,
        })
        pendingByCompany.set(requirement.company_id, group)
      }

      // One email per vendor covering everything outstanding, not one per document.
      for (const [companyId, group] of pendingByCompany.entries()) {
        const deliveryIds = group.items.map((item) => item.deliveryId)
        const subject = buildComplianceAutopilotSubject(group.items)

        try {
          // Chasing a document without saying where to put it is what made this
          // email easy to ignore. Only an existing link is used; an unattended
          // job must not hand out new access.
          const portalToken = await findExistingCompanyPortalToken({
            supabase,
            orgId: org.id,
            companyId,
          }).catch(() => null)
          const portalUrl = portalToken && appBaseUrl ? `${appBaseUrl}/s/${portalToken}/compliance` : null

          const sent = await sendComplianceAutopilotEmail({
            to: group.recipientEmail,
            recipientName: group.recipientName,
            companyName: group.companyName,
            items: group.items,
            orgName: org.name,
            orgLogoUrl: org.logo_url,
            orgSlug: org.slug,
            portalUrl,
          })

          await supabase
            .from("compliance_autopilot_deliveries")
            .update({
              status: sent ? "sent" : "skipped",
              sent_at: sent ? new Date().toISOString() : null,
              subject,
              error_message: null,
            })
            .in("id", deliveryIds)

          if (sent) {
            metrics.sent += group.items.length
            metrics.emails += 1
          } else {
            metrics.skipped += group.items.length
          }
        } catch (error) {
          metrics.failed += group.items.length
          await supabase
            .from("compliance_autopilot_deliveries")
            .update({
              status: "failed",
              error_message: error instanceof Error ? error.message : "Unknown error",
            })
            .in("id", deliveryIds)
        }
      }

      const issueTotal =
        issueCounts.missing +
        issueCounts.expiring +
        issueCounts.expired +
        issueCounts.rejected +
        issueCounts.escalation
      if (issueTotal > 0 && today.getUTCDay() === 1) {
        await recordEvent({
          orgId: org.id,
          eventType: "compliance_autopilot_digest",
          entityType: "compliance",
          entityId: org.id,
          channel: "notification",
          payload: {
            message: `${issueTotal} compliance ${issueTotal === 1 ? "item needs" : "items need"} attention`,
            missing: issueCounts.missing,
            expiring: issueCounts.expiring,
            expired: issueCounts.expired + issueCounts.escalation,
            rejected: issueCounts.rejected,
          },
        }).catch(() => null)
        metrics.digests += 1
      }

      await supabase
        .from("compliance_autopilot_runs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          metrics: {
            requirements: requirementRows.length,
            issues: issueCounts,
          },
        })
        .eq("id", run.id)
    } catch (error) {
      metrics.failed += 1
      await supabase
        .from("compliance_autopilot_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : "Unknown error",
        })
        .eq("id", run.id)
    }
  }

  return metrics
}
