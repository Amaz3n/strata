import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAuthorization } from "@/lib/services/authorization"
import { commitmentInputSchema, commitmentUpdateSchema, commitmentLineInputSchema, commitmentLineUpdateSchema, type CommitmentInput, type CommitmentUpdateInput, type CommitmentLineInput, type CommitmentLineUpdateInput } from "@/lib/validation/commitments"

export type CommitmentStatus = "draft" | "approved" | "complete" | "canceled"

export interface CommitmentSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  company_id?: string
  company_name?: string
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

export interface CommitmentLine {
  id: string
  org_id: string
  commitment_id: string
  cost_code_id: string
  cost_code_code?: string
  cost_code_name?: string
  description: string
  quantity: number
  unit: string
  unit_cost_cents: number
  total_cents: number
  sort_order: number
}

function mapCommitment(row: any): CommitmentSummary {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    company_id: row.company_id ?? undefined,
    company_name: row.company?.name ?? undefined,
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
  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "company",
    resourceId: companyId,
  })

  const { data, error } = await supabase
    .from("commitments")
    .select(
      `
      id, org_id, project_id, company_id, title, status, total_cents, currency, issued_at, start_date, end_date, created_at, updated_at,
      project:projects(id, name),
      company:companies(id, name)
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
    .select("id, commitment_id, total_cents, status, paid_cents")
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
    if (typeof bill.paid_cents === "number") {
      current.paid += bill.paid_cents
    } else if (bill.status === "paid") {
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

export async function listProjectCommitments(projectId: string, orgId?: string): Promise<CommitmentSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  const { data, error } = await supabase
    .from("commitments")
    .select(
      `
      id, org_id, project_id, company_id, title, status, total_cents, currency, issued_at, start_date, end_date, created_at, updated_at,
      project:projects(id, name),
      company:companies(id, name)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list commitments: ${error.message}`)
  }

  const commitments = (data ?? []).map(mapCommitment)
  const commitmentIds = commitments.map((c) => c.id)
  if (commitmentIds.length === 0) return commitments

  const { data: bills, error: billError } = await supabase
    .from("vendor_bills")
    .select("id, commitment_id, total_cents, status, paid_cents")
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
    if (typeof bill.paid_cents === "number") {
      current.paid += bill.paid_cents
    } else if (bill.status === "paid") {
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
  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: parsed.project_id,
  })

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

  const { data: existing, error: existingError } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, total_cents, currency, start_date, end_date, issued_at, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Commitment not found")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

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

// ============================================================================
// Commitment Lines
// ============================================================================

function mapCommitmentLine(row: any): CommitmentLine {
  return {
    id: row.id,
    org_id: row.org_id,
    commitment_id: row.commitment_id,
    cost_code_id: row.cost_code_id,
    cost_code_code: row.cost_code?.code ?? undefined,
    cost_code_name: row.cost_code?.name ?? undefined,
    description: row.description,
    quantity: row.quantity ?? 1,
    unit: row.unit,
    unit_cost_cents: row.unit_cost_cents,
    total_cents: (row.quantity ?? 1) * row.unit_cost_cents,
    sort_order: row.sort_order ?? 0,
  }
}

export async function listCommitmentLines(commitmentId: string): Promise<CommitmentLine[]> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, project_id")
    .eq("id", commitmentId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or access denied")
  }

  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId,
    projectId: commitment.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  const { data, error } = await supabase
    .from("commitment_lines")
    .select(`
      id, org_id, commitment_id, cost_code_id, description, quantity, unit, unit_cost_cents, sort_order,
      cost_code:cost_codes(code, name)
    `)
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to list commitment lines: ${error.message}`)
  }

  return (data ?? []).map(mapCommitmentLine)
}

export async function createCommitmentLine(commitmentId: string, input: CommitmentLineInput): Promise<CommitmentLine> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Verify commitment exists and belongs to org
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, project_id")
    .eq("id", commitmentId)
    .eq("org_id", orgId)
    .single()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or access denied")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: commitment.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  const validated = commitmentLineInputSchema.parse(input)

  const { data, error } = await supabase
    .from("commitment_lines")
    .insert({
      org_id: orgId,
      commitment_id: commitmentId,
      ...validated,
    })
    .select(`
      id, org_id, commitment_id, cost_code_id, description, quantity, unit, unit_cost_cents, sort_order,
      cost_code:cost_codes(code, name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create commitment line: ${error?.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment_line",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_created",
    payload: {
      project_id: commitment.project_id,
      commitment_id: commitmentId,
      commitment_line_id: data.id,
      cost_code_id: validated.cost_code_id,
    },
  })

  return mapCommitmentLine(data)
}

export async function updateCommitmentLine(lineId: string, input: CommitmentLineUpdateInput): Promise<CommitmentLine> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const validated = commitmentLineUpdateSchema.parse(input)

  // Get existing line for audit
  const { data: existing, error: existingError } = await supabase
    .from("commitment_lines")
    .select(`
      id, commitment_id, cost_code_id, description, quantity, unit, unit_cost_cents, sort_order,
      commitment:commitments(project_id)
    `)
    .eq("id", lineId)
    .eq("org_id", orgId)
    .single()

  if (existingError || !existing) {
    throw new Error("Commitment line not found or access denied")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: (existing as any).commitment?.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_line",
    resourceId: lineId,
  })

  const { data, error } = await supabase
    .from("commitment_lines")
    .update(validated)
    .eq("id", lineId)
    .eq("org_id", orgId)
    .select(`
      id, org_id, commitment_id, cost_code_id, description, quantity, unit, unit_cost_cents, sort_order,
      cost_code:cost_codes(code, name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update commitment line: ${error?.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_line",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_updated",
    payload: {
      project_id: (existing as any).commitment?.project_id,
      commitment_id: (existing as any).commitment_id,
      commitment_line_id: data.id,
    },
  })

  return mapCommitmentLine(data)
}

export async function deleteCommitmentLine(lineId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Get existing line for audit
  const { data: existing, error: existingError } = await supabase
    .from("commitment_lines")
    .select(`
      id, commitment_id,
      commitment:commitments(project_id)
    `)
    .eq("id", lineId)
    .eq("org_id", orgId)
    .single()

  if (existingError || !existing) {
    throw new Error("Commitment line not found or access denied")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: (existing as any).commitment?.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_line",
    resourceId: lineId,
  })

  const { error } = await supabase
    .from("commitment_lines")
    .delete()
    .eq("id", lineId)
    .eq("org_id", orgId)

  if (error) {
    throw new Error(`Failed to delete commitment line: ${error.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "delete",
    entityType: "commitment_line",
    entityId: lineId,
    before: existing,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_deleted",
    payload: {
      project_id: (existing as any).commitment?.project_id,
      commitment_id: (existing as any).commitment_id,
      commitment_line_id: lineId,
    },
  })
}
