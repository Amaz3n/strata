import type { ComplianceDocument, ComplianceRequirementStatus } from "@/lib/types"
import { getCompaniesComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { resolveCompanyRecipients, type CompanyRecipient } from "@/lib/services/directory"
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

type ReminderKind = "missing" | "expiring" | "expired" | "rejected" | "escalation" | "deficient"

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

interface PendingGroup {
  companyName: string
  recipientEmail: string
  recipientName: string | null
  items: Array<{
    deliveryId: string
    documentName: string
    reminderKind: "missing" | "expiring" | "expired" | "rejected" | "deficient"
    expiryDate: string | null
    rejectionReason: string | null
    /** What is short about a document that is on file and still not enough. */
    deficiency: string | null
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

function weekKey(date: Date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const week = Math.floor((current - start) / (7 * DAY_MS)) + 1
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * What to chase this vendor about for one requirement, given the verdict the
 * compliance tab shows for it.
 *
 * Driven by `ComplianceRequirementStatus` rather than by "the newest document
 * of this type", which is what it used to re-derive for itself. That derivation
 * knew about presence and expiry and nothing else, so a certificate that was on
 * file, approved, and $500k short of the required $1M produced no chase at all:
 * the payment hold blocked every payable to that vendor and the only person who
 * could have fixed it was never told. `deficient` is that case.
 */
function buildReminder({
  status,
  today,
}: {
  status: ComplianceRequirementStatus
  today: Date
}): {
  kind: ReminderKind
  bucket: string
  days?: number | null
  expiryDate?: string | null
  rejectionReason?: string | null
  deficiency?: string | null
} | null {
  const document = status.document
  const expiryDate = document?.expiry_date ?? null

  switch (status.state) {
    // Satisfied, waived, or already with a reviewer. None of these are the
    // vendor's move to make.
    case "met":
    case "waived":
    case "pending":
      return null

    case "missing":
      return { kind: "missing", bucket: `missing:${weekKey(today)}`, days: null, expiryDate: null }

    // A rejection used to produce no chase at all: the vendor was told nothing
    // and the autopilot only knew missing and expiring, so a returned
    // certificate was invisible from both sides until someone opened the portal.
    case "rejected":
      return {
        kind: "rejected",
        bucket: `rejected:${document?.id ?? status.requirement.id}:${weekKey(today)}`,
        days: null,
        expiryDate,
        rejectionReason: document?.rejection_reason ?? null,
      }

    case "deficient":
      return {
        kind: "deficient",
        // Keyed on what is wrong, not on the week: a vendor who fixes the
        // coverage but not the endorsement should hear about the endorsement
        // rather than nothing, and re-sending the same shortfall weekly is what
        // the weekly bucket is for.
        bucket: `deficient:${status.deficiency?.codes.join("+") ?? "unspecified"}:${weekKey(today)}`,
        days: status.days_until_expiry,
        expiryDate,
        deficiency: status.deficiency?.message ?? null,
      }

    case "expired": {
      const days = status.days_until_expiry
      if (days === null || days >= 0 || !expiryDate) return null
      // Escalate on a schedule rather than once per calendar week, so ignoring
      // the run-up no longer buys silence.
      const daysOverdue = Math.abs(days)
      const step = OVERDUE_ESCALATION_DAYS.filter((mark) => mark <= daysOverdue).pop()
      if (step === undefined) return null
      return {
        kind: daysOverdue >= 14 ? "escalation" : "expired",
        bucket: `expired:${step}:${expiryDate}`,
        days,
        expiryDate,
      }
    }

    case "expiring": {
      const days = status.days_until_expiry
      if (days === null || days < 0 || !expiryDate) return null
      const window = status.requirement.document_type?.expiry_warning_days ?? 30
      if (!expiryReminderDays(window).includes(days)) return null
      return { kind: "expiring", bucket: `expiring:${days}:${expiryDate}`, days, expiryDate }
    }

    default:
      return null
  }
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
      companies!inner(id, name, email, compliance_monitoring_enabled),
      compliance_document_types(id, name, code, has_expiry, expiry_warning_days)
    `,
    )
    .eq("org_id", orgId)
    .eq("is_required", true)
    .eq("companies.compliance_monitoring_enabled", true)

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
  companyId: string
  companyName: string | null
  documentTypeId: string
  documentTypeName: string | null
  requirementId: string
  document: ComplianceDocument | null
  reminder: NonNullable<ReturnType<typeof buildReminder>>
  recipient: CompanyRecipient | null
  /** Keys already delivered for this org, loaded once per run. */
  alreadyDelivered: Set<string>
}) {
  const idempotencyKey = [
    "compliance",
    args.reminder.kind,
    args.companyId,
    args.documentTypeId,
    args.reminder.bucket,
  ].join(":")

  // Checked against a set loaded once per org rather than a query per
  // requirement. Now that org defaults are resolved per vendor, a mid-sized
  // builder can reach several hundred requirements in a run, and this used to
  // be a sequential round-trip for every one of them.
  if (args.alreadyDelivered.has(idempotencyKey)) return null
  args.alreadyDelivered.add(idempotencyKey)

  const { data, error } = await args.supabase
    .from("compliance_autopilot_deliveries")
    .insert({
      org_id: args.orgId,
      run_id: args.runId,
      company_id: args.companyId,
      contact_id: args.recipient?.contactId ?? null,
      document_type_id: args.documentTypeId,
      requirement_id: args.requirementId,
      document_id: args.document?.id ?? null,
      reminder_kind: args.reminder.kind,
      reminder_bucket: args.reminder.bucket,
      recipient_email: args.recipient?.email ?? null,
      recipient_name: args.recipient?.name ?? null,
      subject: args.documentTypeName
        ? `${args.documentTypeName} ${args.reminder.kind}`
        : args.reminder.kind,
      status: args.recipient?.email ? "queued" : "skipped",
      idempotency_key: idempotencyKey,
      payload: {
        company_name: args.companyName,
        document_name: args.documentTypeName,
        expiry_date: args.reminder.expiryDate ?? null,
        days_until_expiry: args.reminder.days ?? null,
        deficiency: args.reminder.deficiency ?? null,
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
              issues: { missing: 0, expiring: 0, expired: 0, rejected: 0, escalation: 0, deficient: 0 },
            },
          })
          .eq("id", run.id)
        continue
      }

      // The verdicts, from the same function the compliance tab renders. Waivers,
      // supersession, revocation and coverage shortfalls are all decided in
      // there — this loop used to re-derive the first three and never knew about
      // the fourth.
      const [statusByCompany, recipientsByCompany] = await Promise.all([
        getCompaniesComplianceStatusWithClient(supabase, org.id, companyIds),
        resolveCompanyRecipients(supabase, org.id, companyIds),
      ])
      const companiesById = new Map(
        requirementRows
          .map((row) => row.companies)
          .filter((company): company is NonNullable<RequirementRow["companies"]> => Boolean(company))
          .map((company) => [company.id, company]),
      )
      // Every reminder this org has already sent, in one read. The per-vendor
      // check that replaced it was a round-trip per requirement, and resolving
      // org defaults multiplies requirements by the whole vendor list.
      // Bounded to the window the buckets can actually reach: the longest is a
      // 60-day overdue escalation, and a weekly bucket key changes every week.
      // Unbounded, this read grows with the org forever and the run gets slower
      // every night it succeeds.
      const deliveryHorizon = new Date(today.getTime() - 120 * DAY_MS).toISOString()
      const { data: deliveredRows } = await supabase
        .from("compliance_autopilot_deliveries")
        .select("idempotency_key")
        .eq("org_id", org.id)
        .gte("created_at", deliveryHorizon)
      const alreadyDelivered = new Set(
        (deliveredRows ?? []).map((row: { idempotency_key: string }) => row.idempotency_key),
      )

      const issueCounts: Record<ReminderKind, number> = {
        missing: 0,
        expiring: 0,
        expired: 0,
        rejected: 0,
        escalation: 0,
        deficient: 0,
      }
      const pendingByCompany = new Map<string, PendingGroup>()

      for (const [companyId, status] of statusByCompany.entries()) {
        const company = companiesById.get(companyId) ?? null
        const recipient = recipientsByCompany.get(companyId) ?? null

        for (const requirementStatus of status.statuses) {
        const reminder = buildReminder({ status: requirementStatus, today })
        if (!reminder) continue
        const documentTypeName = requirementStatus.requirement.document_type?.name ?? null

        issueCounts[reminder.kind] += 1
        const deliveryId = await createDeliveryIfNeeded({
          supabase,
          orgId: org.id,
          runId: run.id,
          companyId,
          companyName: company?.name ?? null,
          documentTypeId: requirementStatus.requirement.document_type_id,
          documentTypeName,
          requirementId: requirementStatus.requirement.id,
          document: requirementStatus.document,
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
        // The builder's side of a shortfall. Deliberately in-app only: it is
        // not in EMAIL_NOTIFICATION_TYPES, and wiring a notification without a
        // settings row to govern it is how the last silent-no-send bug shipped.
        if (reminder.kind === "deficient") {
          await recordEvent({
            orgId: org.id,
            eventType: "compliance_document_deficient",
            entityType: "company",
            entityId: companyId,
            channel: "notification",
            payload: {
              company_id: companyId,
              company_name: company?.name ?? null,
              document_name: documentTypeName,
              document_type_id: requirementStatus.requirement.document_type_id,
              deficiency: reminder.deficiency ?? null,
            },
          }).catch(() => null)
        }

        if (reminder.kind === "expiring" || reminder.kind === "escalation") {
          await recordEvent({
            orgId: org.id,
            eventType: "compliance_document_expiring",
            entityType: "company",
            entityId: companyId,
            channel: "notification",
            payload: {
              company_id: companyId,
              company_name: company?.name ?? null,
              document_name: documentTypeName,
              document_type_id: requirementStatus.requirement.document_type_id,
              expiry_date: reminder.expiryDate ?? null,
              days_until_expiry: reminder.days ?? null,
              blocks_payment: reminder.kind === "escalation",
            },
          }).catch(() => null)
        }

        if (!recipient?.email || !documentTypeName || !company) {
          metrics.skipped += 1
          continue
        }

        const group = pendingByCompany.get(companyId) ?? {
          companyName: company.name,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          items: [],
        }
        group.items.push({
          deliveryId,
          documentName: documentTypeName,
          // An escalation is still an expired document to the vendor reading
          // the email; the distinction is in how often we say it, not in what
          // they have to do about it.
          reminderKind: reminder.kind === "escalation" ? "expired" : reminder.kind,
          expiryDate: reminder.expiryDate ?? null,
          rejectionReason: reminder.rejectionReason ?? null,
          deficiency: reminder.deficiency ?? null,
        })
        pendingByCompany.set(companyId, group)
        }
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
        issueCounts.escalation +
        issueCounts.deficient
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
            deficient: issueCounts.deficient,
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
