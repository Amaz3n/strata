import { recordEvent } from "@/lib/services/events"
import { sendComplianceAutopilotEmail } from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const EXPIRY_REMINDER_DAYS = new Set([30, 14, 3])
const DAY_MS = 24 * 60 * 60 * 1000

type ReminderKind = "missing" | "expiring" | "expired"

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
  } | null
}

interface ComplianceDocumentRow {
  id: string
  company_id: string
  document_type_id: string
  status: string
  expiry_date?: string | null
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

export interface ComplianceAutopilotMetrics {
  orgs: number
  requirements: number
  remindersCreated: number
  sent: number
  skipped: number
  failed: number
  digests: number
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

function latestDocumentsByCompanyAndType(rows: ComplianceDocumentRow[]) {
  const latest = new Map<string, ComplianceDocumentRow>()
  for (const row of rows) {
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
}): { kind: ReminderKind; bucket: string; days?: number | null; expiryDate?: string | null } | null {
  const docType = requirement.compliance_document_types
  if (!docType) return null

  if (!document) {
    const bucket = `missing:${weekKey(today)}`
    return { kind: "missing", bucket, days: null, expiryDate: null }
  }

  if (document.status === "pending_review" || document.status === "submitted") {
    return null
  }

  if (document.status !== "approved") {
    const bucket = `missing:${weekKey(today)}`
    return { kind: "missing", bucket, days: null, expiryDate: document.expiry_date ?? null }
  }

  if (!docType.has_expiry || !document.expiry_date) return null

  const days = daysUntil(document.expiry_date, today)
  if (days < 0) {
    return {
      kind: "expired",
      bucket: `expired:${weekKey(today)}`,
      days,
      expiryDate: document.expiry_date,
    }
  }
  if (EXPIRY_REMINDER_DAYS.has(days)) {
    return {
      kind: "expiring",
      bucket: `expiring:${days}:${document.expiry_date}`,
      days,
      expiryDate: document.expiry_date,
    }
  }
  return null
}

async function createDeliveryIfNeeded(args: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  runId: string
  requirement: RequirementRow
  document?: ComplianceDocumentRow
  reminder: NonNullable<ReturnType<typeof buildReminder>>
  recipient: ReturnType<typeof recipientForCompany>
}) {
  const idempotencyKey = [
    "compliance",
    args.reminder.kind,
    args.requirement.company_id,
    args.requirement.document_type_id,
    args.reminder.bucket,
  ].join(":")

  const { data: existing, error: existingError } = await args.supabase
    .from("compliance_autopilot_deliveries")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to check compliance delivery: ${existingError.message}`)
  }
  if (existing) return null

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
    skipped: 0,
    failed: 0,
    digests: 0,
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
      const { data: requirements, error: requirementsError } = await supabase
        .from("company_compliance_requirements")
        .select(
          `
          id, org_id, company_id, document_type_id, is_required,
          companies(id, name, email),
          compliance_document_types(id, name, code, has_expiry)
        `,
        )
        .eq("org_id", org.id)
        .eq("is_required", true)

      if (requirementsError) throw requirementsError

      const requirementRows = ((requirements ?? []) as unknown as Array<
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
      metrics.requirements += requirementRows.length
      const companyIds = Array.from(new Set(requirementRows.map((row) => row.company_id)))

      if (companyIds.length === 0) {
        await supabase
          .from("compliance_autopilot_runs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            metrics: { requirements: 0, issues: { missing: 0, expiring: 0, expired: 0 } },
          })
          .eq("id", run.id)
        continue
      }

      const [documentsResult, waiversResult, contactsResult] = await Promise.all([
        supabase
          .from("compliance_documents")
          .select("id, company_id, document_type_id, status, expiry_date, created_at")
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

      const issueCounts: Record<ReminderKind, number> = {
        missing: 0,
        expiring: 0,
        expired: 0,
      }

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
        })

        if (!deliveryId) continue
        metrics.remindersCreated += 1

        if (!recipient?.email || !requirement.compliance_document_types || !requirement.companies) {
          metrics.skipped += 1
          continue
        }

        try {
          const messageId = await sendComplianceAutopilotEmail({
            to: recipient.email,
            recipientName: recipient.name,
            companyName: requirement.companies.name,
            documentName: requirement.compliance_document_types.name,
            reminderKind: reminder.kind,
            expiryDate: reminder.expiryDate,
            daysUntilExpiry: reminder.days,
            orgName: org.name,
            orgLogoUrl: org.logo_url,
            orgSlug: org.slug,
          })

          await supabase
            .from("compliance_autopilot_deliveries")
            .update({
              status: messageId ? "sent" : "skipped",
              sent_at: messageId ? new Date().toISOString() : null,
              delivered_at: null,
              error_message: null,
              payload: {
                provider_message_id: messageId ?? null,
                company_name: requirement.companies.name,
                document_name: requirement.compliance_document_types.name,
                expiry_date: reminder.expiryDate ?? null,
                days_until_expiry: reminder.days ?? null,
              },
            })
            .eq("id", deliveryId)

          if (messageId) metrics.sent += 1
          else metrics.skipped += 1
        } catch (error) {
          metrics.failed += 1
          await supabase
            .from("compliance_autopilot_deliveries")
            .update({
              status: "failed",
              error_message: error instanceof Error ? error.message : "Unknown error",
            })
            .eq("id", deliveryId)
        }
      }

      const issueTotal = issueCounts.missing + issueCounts.expiring + issueCounts.expired
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
            expired: issueCounts.expired,
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
