import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission } from "@/lib/services/permissions"
import { ensureVendorAccountPortalToken } from "@/lib/services/portal-access"
import {
  getLatestPrequalificationWithClient,
  markPrequalificationInvited,
} from "@/lib/services/prequalification"
import {
  sendPrequalificationDecisionEmail,
  sendPrequalificationRequestEmail,
} from "@/lib/services/mailer"
import { NotificationService } from "@/lib/services/notifications"
import {
  PREQUAL_FIELD_KEYS,
  PREQUAL_FIELD_LABELS,
  prequalFieldMode,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification"

export type PrequalificationInviteResult = {
  sent: boolean
  email: string | null
  portalUrl: string
  reason?: string
}

function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
  )
}

function money(cents?: number | null): string | null {
  if (cents == null) return null
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

/**
 * Plain-language summary of what a program asks for, so the invitation email
 * tells a vendor what they are walking into instead of just linking them.
 */
export function describePrequalificationProgram(
  template: PrequalificationTemplate,
  documentTypeNames: Map<string, string>,
): string[] {
  const asked: string[] = []

  const fieldLabels = PREQUAL_FIELD_KEYS.filter(
    (key) => prequalFieldMode(template, key) !== "off",
  ).map((key) => PREQUAL_FIELD_LABELS[key])
  if (fieldLabels.length > 0) asked.push(`Company details: ${fieldLabels.join(", ")}`)

  if (template.questions.length > 0) {
    const sections = Array.from(new Set(template.questions.map((question) => question.section)))
    asked.push(
      `${template.questions.length} question${template.questions.length === 1 ? "" : "s"} (${sections.join(", ")})`,
    )
  }

  if (template.references_required > 0) {
    asked.push(
      `${template.references_required} project reference${template.references_required === 1 ? "" : "s"}`,
    )
  }

  for (const document of template.documents) {
    const name = documentTypeNames.get(document.document_type_id)
    if (name) asked.push(`${name}${document.is_required ? "" : " (optional)"}`)
  }

  return asked
}

/**
 * Sends the vendor their link. Separate from `requestPrequalification` because
 * recording the request and reaching the vendor fail independently — a bounced
 * invitation must not roll back a request the builder can still chase by phone.
 */
export async function sendPrequalificationInvite({
  companyId,
  contactId,
  message,
  orgId,
}: {
  companyId: string
  contactId?: string | null
  message?: string
  orgId?: string
}): Promise<PrequalificationInviteResult> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["directory.write", "prequal.review"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const [companyResult, orgResult, prequalification] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, email")
      .eq("org_id", resolvedOrgId)
      .eq("id", companyId)
      .maybeSingle(),
    supabase.from("orgs").select("id, name, slug, logo_url").eq("id", resolvedOrgId).maybeSingle(),
    getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId),
  ])

  const company = companyResult.data
  if (!company) throw new Error("Company not found")
  if (!prequalification) throw new Error("Request a prequalification before sending an invitation")

  const contact = await resolveRecipientContact({
    supabase,
    orgId: resolvedOrgId,
    companyId,
    contactId,
  })
  const recipientEmail = contact?.email ?? company.email?.trim() ?? null

  const token = await ensureVendorAccountPortalToken({
    companyId,
    contactId: contact?.id ?? contactId ?? null,
    orgId: resolvedOrgId,
  })
  const base = appBaseUrl()
  const portalPath = `/s/${token.token}/prequalification`
  const portalUrl = base ? `${base}${portalPath}` : portalPath

  await markPrequalificationInvited({
    supabase,
    orgId: resolvedOrgId,
    prequalificationId: prequalification.id,
    portalTokenId: token.id,
  })

  if (!recipientEmail) {
    return {
      sent: false,
      email: null,
      portalUrl,
      reason: "This vendor has no email on the company or any contact — copy the link instead.",
    }
  }

  const documentTypeNames = await loadDocumentTypeNames({
    supabase,
    orgId: resolvedOrgId,
    ids: prequalification.template.documents.map((entry) => entry.document_type_id),
  })

  const sent = await sendPrequalificationRequestEmail({
    to: recipientEmail,
    recipientName: contact?.full_name ?? null,
    companyName: company.name,
    orgName: orgResult.data?.name ?? "Arc",
    orgLogoUrl: orgResult.data?.logo_url ?? null,
    orgSlug: orgResult.data?.slug ?? null,
    portalLink: portalUrl,
    askedFor: describePrequalificationProgram(prequalification.template, documentTypeNames),
    message: message?.trim() || null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prequalification.invited",
    entityType: "prequalification",
    entityId: prequalification.id,
    channel: "activity",
    payload: { company_id: companyId, email: recipientEmail, sent },
  }).catch(() => null)

  return { sent, email: recipientEmail, portalUrl }
}

/** Tells the vendor what the builder decided. Best effort — never blocks a review. */
export async function sendPrequalificationDecisionNotice({
  companyId,
  prequalificationId,
  decision,
  expiresAt,
  singleProjectLimitCents,
  aggregateLimitCents,
  reviewNotes,
  orgId,
}: {
  companyId: string
  prequalificationId: string
  decision: "approved" | "approved_with_limits" | "declined"
  expiresAt?: string | null
  singleProjectLimitCents?: number | null
  aggregateLimitCents?: number | null
  reviewNotes?: string | null
  orgId?: string
}): Promise<boolean> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [companyResult, orgResult] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, email")
      .eq("org_id", resolvedOrgId)
      .eq("id", companyId)
      .maybeSingle(),
    supabase.from("orgs").select("id, name, slug, logo_url").eq("id", resolvedOrgId).maybeSingle(),
  ])
  const company = companyResult.data
  if (!company) return false

  const contact = await resolveRecipientContact({
    supabase,
    orgId: resolvedOrgId,
    companyId,
    contactId: null,
  })
  const recipientEmail = contact?.email ?? company.email?.trim() ?? null
  if (!recipientEmail) return false

  const sent = await sendPrequalificationDecisionEmail({
    to: recipientEmail,
    recipientName: contact?.full_name ?? null,
    companyName: company.name,
    orgName: orgResult.data?.name ?? "Arc",
    orgLogoUrl: orgResult.data?.logo_url ?? null,
    orgSlug: orgResult.data?.slug ?? null,
    decision,
    expiresAt: expiresAt ?? null,
    singleProjectLimit: money(singleProjectLimitCents),
    aggregateLimit: money(aggregateLimitCents),
    reviewNotes: reviewNotes ?? null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "prequalification.decision_sent",
    entityType: "prequalification",
    entityId: prequalificationId,
    channel: "activity",
    payload: { company_id: companyId, decision, email: recipientEmail, sent },
  }).catch(() => null)

  return sent
}

/**
 * Tells the person who asked for the package that it came back. Runs from the
 * portal, which has no authenticated user, so it takes an explicit client.
 */
export async function notifyPrequalificationSubmitted({
  supabase,
  orgId,
  companyId,
  prequalificationId,
  requestedBy,
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  prequalificationId: string
  requestedBy: string | null
}): Promise<void> {
  if (!requestedBy) return

  const company = await supabase
    .from("companies")
    .select("name")
    .eq("org_id", orgId)
    .eq("id", companyId)
    .maybeSingle()
  const companyName = company.data?.name ?? "A vendor"

  await new NotificationService()
    .createAndQueue({
      orgId,
      userId: requestedBy,
      type: "prequalification_submitted",
      title: `${companyName} returned their prequalification`,
      message: "The package is ready for your review.",
      entityType: "prequalification",
      entityId: prequalificationId,
      metadata: { company_id: companyId },
    })
    .catch(() => undefined)
}

async function resolveRecipientContact({
  supabase,
  orgId,
  companyId,
  contactId,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  companyId: string
  contactId?: string | null
}): Promise<{ id: string; full_name: string | null; email: string } | null> {
  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, full_name, email")
      .eq("org_id", orgId)
      .eq("id", contactId)
      .maybeSingle()
    if (data?.email) {
      return { id: data.id, full_name: data.full_name ?? null, email: String(data.email).trim() }
    }
  }

  const { data } = await supabase
    .from("contacts")
    .select("id, full_name, email")
    .eq("org_id", orgId)
    .eq("primary_company_id", companyId)
    .not("email", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
  const first = data?.[0]
  return first?.email
    ? { id: first.id, full_name: first.full_name ?? null, email: String(first.email).trim() }
    : null
}

async function loadDocumentTypeNames({
  supabase,
  orgId,
  ids,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  ids: string[]
}): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { data } = await supabase
    .from("compliance_document_types")
    .select("id, name")
    .eq("org_id", orgId)
    .in("id", ids)
  return new Map((data ?? []).map((row) => [String(row.id), String(row.name)]))
}
