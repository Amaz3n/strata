import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { commitmentInputSchema, commitmentUpdateSchema, type CommitmentInput, type CommitmentUpdateInput } from "@/lib/validation/commitments"

export type CommitmentStatus = "draft" | "approved" | "complete" | "canceled"

export interface CommitmentSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  company_id?: string
  title: string
  status: CommitmentStatus | string
  total_cents?: number
  currency: string
  start_date?: string
  end_date?: string
  issued_at?: string
  created_at: string
  updated_at?: string
  billed_cents?: number
  paid_cents?: number
}

function mapCommitment(row: any): CommitmentSummary {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    company_id: row.company_id ?? undefined,
    title: row.title,
    status: row.status ?? "draft",
    total_cents: row.total_cents ?? undefined,
    currency: row.currency ?? "usd",
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    issued_at: row.issued_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  }
}

export async function listCompanyCommitments(companyId: string, orgId?: string): Promise<CommitmentSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("commitments")
    .select(
      `
      id, org_id, project_id, company_id, title, status, total_cents, currency, issued_at, start_date, end_date, created_at, updated_at,
      project:projects(id, name)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list commitments: ${error.message}`)
  }

  const commitments = (data ?? []).map(mapCommitment)
  const commitmentIds = commitments.map((c) => c.id)
  if (commitmentIds.length === 0) return commitments

  const { data: bills, error: billError } = await supabase
    .from("vendor_bills")
    .select("id, commitment_id, total_cents, status")
    .eq("org_id", resolvedOrgId)
    .in("commitment_id", commitmentIds)

  if (billError) {
    throw new Error(`Failed to load vendor bills: ${billError.message}`)
  }

  const billedByCommitment = new Map<string, { billed: number; paid: number }>()
  for (const bill of bills ?? []) {
    const commitmentId = bill.commitment_id as string | null
    if (!commitmentId) continue
    const current = billedByCommitment.get(commitmentId) ?? { billed: 0, paid: 0 }
    current.billed += bill.total_cents ?? 0
    if (bill.status === "paid") {
      current.paid += bill.total_cents ?? 0
    }
    billedByCommitment.set(commitmentId, current)
  }

  return commitments.map((c) => {
    const totals = billedByCommitment.get(c.id)
    return {
      ...c,
      billed_cents: totals?.billed ?? 0,
      paid_cents: totals?.paid ?? 0,
    }
  })
}

export async function createCommitment({ input, orgId }: { input: CommitmentInput; orgId?: string }): Promise<CommitmentSummary> {
  const parsed = commitmentInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("commitments")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      company_id: parsed.company_id,
      title: parsed.title,
      status: parsed.status ?? "draft",
      total_cents: parsed.total_cents,
      currency: "usd",
      start_date: parsed.start_date ?? null,
      end_date: parsed.end_date ?? null,
    })
    .select(
      `
      id, org_id, project_id, company_id, title, status, total_cents, currency, issued_at, start_date, end_date, created_at, updated_at,
      project:projects(id, name)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create commitment: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "commitment_created",
    entityType: "commitment",
    entityId: data.id as string,
    payload: { company_id: parsed.company_id, project_id: parsed.project_id, total_cents: parsed.total_cents },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment",
    entityId: data.id as string,
    after: data,
  })

  return mapCommitment(data)
}

export async function updateCommitment({
  commitmentId,
  input,
  orgId,
}: {
  commitmentId: string
  input: CommitmentUpdateInput
  orgId?: string
}): Promise<CommitmentSummary> {
  const parsed = commitmentUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, total_cents, currency, start_date, end_date, issued_at, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Commitment not found")
  }

  const { data, error } = await supabase
    .from("commitments")
    .update({
      title: parsed.title ?? existing.title,
      status: parsed.status ?? existing.status,
      total_cents: parsed.total_cents ?? existing.total_cents,
      start_date: parsed.start_date ?? existing.start_date,
      end_date: parsed.end_date ?? existing.end_date,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .select(
      `
      id, org_id, project_id, company_id, title, status, total_cents, currency, issued_at, start_date, end_date, created_at, updated_at,
      project:projects(id, name)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update commitment: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapCommitment(data)
}

