import { createHmac, randomBytes } from "crypto"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  createBidPackageInputSchema,
  updateBidPackageInputSchema,
  createBidInviteInputSchema,
  createBidAddendumInputSchema,
  awardBidSubmissionInputSchema,
  type BidPackageStatus,
} from "@/lib/validation/bids"
import { createCommitment } from "@/lib/services/commitments"

export interface BidPackage {
  id: string
  org_id: string
  project_id: string
  title: string
  trade?: string | null
  scope?: string | null
  instructions?: string | null
  due_at?: string | null
  status: BidPackageStatus
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  invite_count?: number
}

export interface BidInvite {
  id: string
  org_id: string
  bid_package_id: string
  company_id: string
  contact_id?: string | null
  invite_email?: string | null
  status: string
  sent_at?: string | null
  last_viewed_at?: string | null
  submitted_at?: string | null
  declined_at?: string | null
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  company?: { id: string; name: string; phone?: string; email?: string }
  contact?: { id: string; full_name: string; email?: string; phone?: string }
}

export interface BidAddendum {
  id: string
  org_id: string
  bid_package_id: string
  number: number
  title?: string | null
  message?: string | null
  issued_at: string
  created_by?: string | null
}

export interface BidSubmission {
  id: string
  org_id: string
  bid_invite_id: string
  status: string
  version: number
  is_current: boolean
  total_cents?: number | null
  currency?: string | null
  submitted_at?: string | null
  created_at: string
  invite?: BidInvite
}

export interface BidAwardResult {
  awardId: string
  commitmentId: string
}

function mapBidPackage(row: any): BidPackage {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    title: row.title,
    trade: row.trade ?? null,
    scope: row.scope ?? null,
    instructions: row.instructions ?? null,
    due_at: row.due_at ?? null,
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    invite_count: (row.bid_invites as any)?.[0]?.count ?? undefined,
  }
}

function mapBidInvite(row: any): BidInvite {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_package_id: row.bid_package_id,
    company_id: row.company_id,
    contact_id: row.contact_id ?? null,
    invite_email: row.invite_email ?? null,
    status: row.status,
    sent_at: row.sent_at ?? null,
    last_viewed_at: row.last_viewed_at ?? null,
    submitted_at: row.submitted_at ?? null,
    declined_at: row.declined_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    company: row.company
      ? {
          id: row.company.id,
          name: row.company.name,
          phone: row.company.phone ?? undefined,
          email: row.company.email ?? undefined,
        }
      : undefined,
    contact: row.contact
      ? {
          id: row.contact.id,
          full_name: row.contact.full_name,
          email: row.contact.email ?? undefined,
          phone: row.contact.phone ?? undefined,
        }
      : undefined,
  }
}

function mapBidAddendum(row: any): BidAddendum {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_package_id: row.bid_package_id,
    number: row.number,
    title: row.title ?? null,
    message: row.message ?? null,
    issued_at: row.issued_at,
    created_by: row.created_by ?? null,
  }
}

function mapBidSubmission(row: any): BidSubmission {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_invite_id: row.bid_invite_id,
    status: row.status,
    version: row.version,
    is_current: row.is_current,
    total_cents: row.total_cents ?? null,
    currency: row.currency ?? null,
    submitted_at: row.submitted_at ?? null,
    created_at: row.created_at,
    invite: row.bid_invite ? mapBidInvite(row.bid_invite) : undefined,
  }
}

function requireBidPortalSecret() {
  const secret = process.env.BID_PORTAL_SECRET
  if (!secret) {
    throw new Error("Missing BID_PORTAL_SECRET environment variable")
  }
  return secret
}

function getAppUrl() {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_URL ||
    ""
  if (!url) return ""
  if (url.startsWith("http")) return url.replace(/\/$/, "")
  return `https://${url}`.replace(/\/$/, "")
}

async function ensureProjectBiddingStatus(projectId: string, orgId: string, supabase: any) {
  const { data: project } = await supabase
    .from("projects")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  if (project?.status === "planning") {
    await supabase
      .from("projects")
      .update({ status: "bidding" })
      .eq("org_id", orgId)
      .eq("id", projectId)
  }
}

export async function listBidPackages(projectId: string, orgId?: string): Promise<BidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_packages")
    .select(`
      id, org_id, project_id, title, trade, scope, instructions, due_at, status, created_by, created_at, updated_at,
      bid_invites(count)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid packages: ${error.message}`)
  }

  return (data ?? []).map(mapBidPackage)
}

export async function getBidPackage(bidPackageId: string, orgId?: string): Promise<BidPackage> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_packages")
    .select("id, org_id, project_id, title, trade, scope, instructions, due_at, status, created_by, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .single()

  if (error || !data) {
    throw new Error("Bid package not found")
  }

  return mapBidPackage(data)
}

export async function createBidPackage({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidPackage> {
  const parsed = createBidPackageInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_packages")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      trade: parsed.trade ?? null,
      scope: parsed.scope ?? null,
      instructions: parsed.instructions ?? null,
      due_at: parsed.due_at ?? null,
      status: parsed.status ?? "draft",
      created_by: userId,
    })
    .select("id, org_id, project_id, title, trade, scope, instructions, due_at, status, created_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create bid package: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_package_created",
    entityType: "bid_package",
    entityId: data.id as string,
    payload: { title: data.title, project_id: parsed.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_package",
    entityId: data.id as string,
    after: data,
  })

  return mapBidPackage(data)
}

export async function updateBidPackage({
  bidPackageId,
  input,
  orgId,
}: {
  bidPackageId: string
  input: unknown
  orgId?: string
}): Promise<BidPackage> {
  const parsed = updateBidPackageInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("bid_packages")
    .select("id, org_id, project_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Bid package not found")
  }

  const updates: Record<string, any> = {
    updated_at: new Date().toISOString(),
  }
  if (parsed.title !== undefined) updates.title = parsed.title
  if (parsed.trade !== undefined) updates.trade = parsed.trade
  if (parsed.scope !== undefined) updates.scope = parsed.scope
  if (parsed.instructions !== undefined) updates.instructions = parsed.instructions
  if (parsed.due_at !== undefined) updates.due_at = parsed.due_at
  if (parsed.status !== undefined) updates.status = parsed.status

  const { data, error } = await supabase
    .from("bid_packages")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .select("id, org_id, project_id, title, trade, scope, instructions, due_at, status, created_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update bid package: ${error?.message}`)
  }

  if (parsed.status && ["sent", "open"].includes(parsed.status)) {
    await ensureProjectBiddingStatus(existing.project_id, resolvedOrgId, supabase)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_package",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapBidPackage(data)
}

export async function listBidInvites(bidPackageId: string, orgId?: string): Promise<BidInvite[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_invites")
    .select(
      `
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies(id, name, phone, email),
      contact:contacts(id, full_name, email, phone)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid invites: ${error.message}`)
  }

  return (data ?? []).map(mapBidInvite)
}

export async function createBidInvite({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidInvite> {
  const parsed = createBidInviteInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_invites")
    .insert({
      org_id: resolvedOrgId,
      bid_package_id: parsed.bid_package_id,
      company_id: parsed.company_id,
      contact_id: parsed.contact_id ?? null,
      invite_email: parsed.invite_email ?? null,
      status: parsed.status ?? "draft",
      created_by: userId,
    })
    .select(
      `
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies(id, name, phone, email),
      contact:contacts(id, full_name, email, phone)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create bid invite: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_invite_created",
    entityType: "bid_invite",
    entityId: data.id as string,
    payload: { bid_package_id: parsed.bid_package_id, company_id: parsed.company_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_invite",
    entityId: data.id as string,
    after: data,
  })

  return mapBidInvite(data)
}

export async function generateBidInviteLink(
  inviteId: string,
  orgId?: string
): Promise<{ url: string; token: string }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const secret = requireBidPortalSecret()

  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  const { error } = await supabase
    .from("bid_access_tokens")
    .insert({
      org_id: resolvedOrgId,
      bid_invite_id: inviteId,
      token_hash: tokenHash,
      created_by: userId,
    })

  if (error) {
    throw new Error(`Failed to generate bid link: ${error.message}`)
  }

  if (invite.status === "draft") {
    await supabase
      .from("bid_invites")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("id", inviteId)
  }

  const appUrl = getAppUrl()
  const url = `${appUrl}/b/${token}`
  return { url, token }
}

export async function listBidAddenda(bidPackageId: string, orgId?: string): Promise<BidAddendum[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_addenda")
    .select("id, org_id, bid_package_id, number, title, message, issued_at, created_by")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .order("number", { ascending: true })

  if (error) {
    throw new Error(`Failed to list addenda: ${error.message}`)
  }

  return (data ?? []).map(mapBidAddendum)
}

export async function createBidAddendum({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidAddendum> {
  const parsed = createBidAddendumInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("bid_addenda")
    .select("number")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", parsed.bid_package_id)
    .order("number", { ascending: false })
    .limit(1)

  const nextNumber = (existing?.[0]?.number ?? 0) + 1

  const { data, error } = await supabase
    .from("bid_addenda")
    .insert({
      org_id: resolvedOrgId,
      bid_package_id: parsed.bid_package_id,
      number: nextNumber,
      title: parsed.title ?? null,
      message: parsed.message ?? null,
      created_by: userId,
    })
    .select("id, org_id, bid_package_id, number, title, message, issued_at, created_by")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create addendum: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_addendum_created",
    entityType: "bid_addendum",
    entityId: data.id as string,
    payload: { bid_package_id: parsed.bid_package_id, number: nextNumber },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_addendum",
    entityId: data.id as string,
    after: data,
  })

  return mapBidAddendum(data)
}

export async function listBidSubmissions(bidPackageId: string, orgId?: string): Promise<BidSubmission[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_submissions")
    .select(
      `
      id, org_id, bid_invite_id, status, version, is_current, total_cents, currency, submitted_at, created_at,
      bid_invite:bid_invites!inner(
        id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
        declined_at, created_by, created_at, updated_at,
        company:companies(id, name, phone, email),
        contact:contacts(id, full_name, email, phone)
      )
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("bid_invites.bid_package_id", bidPackageId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid submissions: ${error.message}`)
  }

  return (data ?? []).map(mapBidSubmission)
}

export async function awardBidSubmission({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidAwardResult> {
  const parsed = awardBidSubmissionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: submission, error: submissionError } = await supabase
    .from("bid_submissions")
    .select("id, org_id, bid_invite_id, total_cents, currency, status, is_current")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_submission_id)
    .maybeSingle()

  if (submissionError || !submission) {
    throw new Error("Bid submission not found")
  }

  if (!submission.is_current) {
    throw new Error("Only the current submission can be awarded")
  }

  if (submission.total_cents == null) {
    throw new Error("Submission total is required to award")
  }

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id, company_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", submission.bid_invite_id)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  const { data: bidPackage, error: bidPackageError } = await supabase
    .from("bid_packages")
    .select("id, project_id, title, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", invite.bid_package_id)
    .maybeSingle()

  if (bidPackageError || !bidPackage) {
    throw new Error("Bid package not found")
  }

  if (bidPackage.status === "cancelled") {
    throw new Error("Cannot award a cancelled bid package")
  }

  const { data: existingAward } = await supabase
    .from("bid_awards")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackage.id)
    .maybeSingle()

  if (existingAward) {
    throw new Error("This bid package has already been awarded")
  }

  const commitment = await createCommitment({
    input: {
      project_id: bidPackage.project_id,
      company_id: invite.company_id,
      title: `${bidPackage.title} - Award`,
      total_cents: submission.total_cents,
      status: "draft",
    },
    orgId: resolvedOrgId,
  })

  const { data: award, error: awardError } = await supabase
    .from("bid_awards")
    .insert({
      org_id: resolvedOrgId,
      bid_package_id: bidPackage.id,
      awarded_submission_id: submission.id,
      awarded_commitment_id: commitment.id,
      awarded_by: userId,
      notes: parsed.notes ?? null,
    })
    .select("id, org_id, bid_package_id, awarded_submission_id, awarded_commitment_id, awarded_by, awarded_at, notes")
    .single()

  if (awardError || !award) {
    throw new Error(`Failed to create bid award: ${awardError?.message}`)
  }

  await supabase
    .from("bid_packages")
    .update({ status: "awarded", updated_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackage.id)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_awarded",
    entityType: "bid_package",
    entityId: bidPackage.id,
    payload: {
      bid_package_id: bidPackage.id,
      bid_submission_id: submission.id,
      commitment_id: commitment.id,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_award",
    entityId: award.id as string,
    after: award,
  })

  return {
    awardId: award.id as string,
    commitmentId: commitment.id,
  }
}
