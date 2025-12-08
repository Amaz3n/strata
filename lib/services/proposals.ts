import { createHmac, randomBytes } from "crypto"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const proposalLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  line_type: z.enum(["item", "section", "allowance", "option"]).default("item"),
  description: z.string().min(1),
  quantity: z.number().default(1),
  unit: z.string().optional(),
  unit_cost_cents: z.number().int().optional(),
  markup_percent: z.number().optional(),
  is_optional: z.boolean().default(false),
  is_selected: z.boolean().optional(),
  allowance_cents: z.number().int().optional(),
  notes: z.string().optional(),
})

const createProposalSchema = z.object({
  project_id: z.string().uuid(),
  estimate_id: z.string().uuid().optional(),
  recipient_contact_id: z.string().uuid().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  terms: z.string().optional(),
  valid_until: z.string().optional(),
  lines: z.array(proposalLineSchema).min(1),
  markup_percent: z.number().optional(),
  tax_rate: z.number().optional(),
  signature_required: z.boolean().optional(),
})

function requireProposalSecret() {
  const secret = process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing PROPOSAL_SECRET environment variable")
  }
  return secret
}

function calculateTotals(
  lines: z.infer<typeof proposalLineSchema>[],
  defaultMarkup: number,
  taxRate: number,
) {
  let subtotal = 0
  for (const line of lines) {
    const isSelected = line.is_selected ?? true
    if (!line.is_optional || isSelected) {
      const lineCost = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
      const lineMarkup = Math.round(lineCost * (line.markup_percent ?? defaultMarkup) / 100)
      subtotal += lineCost + lineMarkup
    }
  }

  const tax = Math.round(subtotal * taxRate / 100)
  return { subtotal, tax, total: subtotal + tax }
}

export async function createProposal(input: z.infer<typeof createProposalSchema>, orgId?: string) {
  const parsed = createProposalSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const secret = requireProposalSecret()

  const { count, error: countError } = await supabase
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)

  if (countError) {
    throw new Error(`Failed to generate proposal number: ${countError.message}`)
  }

  const number = `P-${String((count ?? 0) + 1).padStart(4, "0")}`

  const markup = parsed.markup_percent ?? 0
  const taxRate = parsed.tax_rate ?? 0
  const totals = calculateTotals(parsed.lines, markup, taxRate)

  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")

  const { data: proposal, error } = await supabase
    .from("proposals")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      estimate_id: parsed.estimate_id ?? null,
      recipient_contact_id: parsed.recipient_contact_id ?? null,
      number,
      title: parsed.title,
      summary: parsed.summary ?? null,
      terms: parsed.terms ?? null,
      valid_until: parsed.valid_until ?? null,
      total_cents: totals.total,
      signature_required: parsed.signature_required ?? true,
      token_hash: tokenHash,
      status: "draft",
      snapshot: {
        markup_percent: markup,
        tax_rate: taxRate,
        subtotal_cents: totals.subtotal,
        tax_cents: totals.tax,
      },
    })
    .select("*")
    .single()

  if (error || !proposal) {
    throw new Error(`Failed to create proposal: ${error?.message}`)
  }

  const linesToInsert = parsed.lines.map((line, idx) => ({
    org_id: resolvedOrgId,
    proposal_id: proposal.id,
    cost_code_id: line.cost_code_id ?? null,
    line_type: line.line_type ?? "item",
    description: line.description,
    quantity: line.quantity ?? 1,
    unit: line.unit ?? null,
    unit_cost_cents: line.unit_cost_cents ?? null,
    markup_percent: line.markup_percent ?? null,
    is_optional: line.is_optional ?? false,
    is_selected: line.is_selected ?? true,
    allowance_cents: line.allowance_cents ?? null,
    notes: line.notes ?? null,
    sort_order: idx,
  }))

  const { error: linesError } = await supabase.from("proposal_lines").insert(linesToInsert)
  if (linesError) {
    throw new Error(`Failed to create proposal lines: ${linesError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "proposal",
    entityId: proposal.id,
    after: { ...proposal, lines: linesToInsert },
  })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

  return {
    proposal,
    viewUrl: `${appUrl}/proposal/${token}`,
  }
}

export async function sendProposal(proposalId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: proposal, error } = await supabase
    .from("proposals")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("org_id", resolvedOrgId)
    .select("*, recipient:contacts(email, full_name)")
    .single()

  if (error || !proposal) {
    throw new Error(`Failed to send proposal: ${error?.message}`)
  }

  await supabase.from("outbox").insert({
    org_id: resolvedOrgId,
    job_type: "send_proposal_email",
    payload: {
      proposal_id: proposalId,
      recipient_email: proposal.recipient?.email,
      recipient_name: proposal.recipient?.full_name,
    },
  })

  return proposal
}

export async function acceptProposal(
  token: string,
  signatureData: { signature_svg?: string | null; signer_name: string; signer_ip?: string },
) {
  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac("sha256", requireProposalSecret()).update(token).digest("hex")

  const { data: proposal, error: findError } = await supabase
    .from("proposals")
    .select("*, lines:proposal_lines(*), project:projects(name)")
    .eq("token_hash", tokenHash)
    .eq("status", "sent")
    .maybeSingle()

  if (findError) {
    throw new Error(`Failed to load proposal: ${findError.message}`)
  }

  if (!proposal) {
    throw new Error("Proposal not found or already accepted")
  }

  if (proposal.valid_until && new Date(proposal.valid_until) < new Date()) {
    throw new Error("Proposal has expired")
  }

  const signaturePayload = {
    signature_svg: signatureData.signature_svg ?? null,
    signer_name: signatureData.signer_name,
    signer_ip: signatureData.signer_ip,
    signed_at: new Date().toISOString(),
  }

  const { error: updateError } = await supabase
    .from("proposals")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      signature_data: signaturePayload,
    })
    .eq("id", proposal.id)

  if (updateError) {
    throw new Error(`Failed to accept proposal: ${updateError.message}`)
  }

  const contractNumber = `C-${(proposal.number ?? "").replace(/^P-?/, "") || (proposal.id ?? "").slice(0, 6)}`
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .insert({
      org_id: proposal.org_id,
      project_id: proposal.project_id,
      proposal_id: proposal.id,
      number: contractNumber,
      title: proposal.title ?? `Contract for ${proposal.project?.name ?? "project"}`,
      status: "active",
      total_cents: proposal.total_cents,
      signed_at: new Date().toISOString(),
      effective_date: new Date().toISOString().split("T")[0],
      terms: proposal.terms,
      signature_data: signaturePayload,
      snapshot: proposal.snapshot,
    })
    .select("*")
    .single()

  if (contractError) {
    throw new Error(`Failed to create contract: ${contractError.message}`)
  }

  const budgetLines = (proposal.lines ?? [])
    .filter((line: any) => line.line_type !== "section" && (!line.is_optional || line.is_selected))
    .map((line: any, idx: number) => ({
      org_id: proposal.org_id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      amount_cents: (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
      sort_order: idx,
    }))

  if (budgetLines.length > 0) {
    const { data: budget, error: budgetError } = await supabase
      .from("budgets")
      .insert({
        org_id: proposal.org_id,
        project_id: proposal.project_id,
        status: "approved",
        total_cents: budgetLines.reduce((sum: number, line: any) => sum + (line.amount_cents ?? 0), 0),
      })
      .select("id")
      .single()

    if (budgetError) {
      throw new Error(`Failed to create budget: ${budgetError.message}`)
    }

    if (budget) {
      const { error: budgetLinesError } = await supabase
        .from("budget_lines")
        .insert(budgetLines.map((line: any) => ({ ...line, budget_id: budget.id })))

      if (budgetLinesError) {
        throw new Error(`Failed to create budget lines: ${budgetLinesError.message}`)
      }
    }
  }

  const allowanceLines = (proposal.lines ?? []).filter((line: any) => line.line_type === "allowance")
  for (const line of allowanceLines) {
    const { error: allowanceError } = await supabase.from("allowances").insert({
      org_id: proposal.org_id,
      project_id: proposal.project_id,
      contract_id: contract.id,
      name: line.description,
      budget_cents: line.allowance_cents ?? (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
    })

    if (allowanceError) {
      throw new Error(`Failed to create allowance: ${allowanceError.message}`)
    }
  }

  try {
    await supabase.from("events").insert({
      org_id: proposal.org_id,
      event_type: "proposal_accepted",
      entity_type: "proposal",
      entity_id: proposal.id,
      payload: { contract_id: contract.id, signer_name: signatureData.signer_name },
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record proposal accepted event", eventError)
  }

  return { proposal, contract }
}

export async function createDrawScheduleFromContract(
  contractId: string,
  draws: Array<{
    title: string
    percent: number
    due_trigger: "date" | "milestone" | "approval"
    due_date?: string
    milestone_id?: string
  }>,
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, project_id, total_cents")
    .eq("id", contractId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (!contract) {
    throw new Error("Contract not found")
  }

  const totalPercent = draws.reduce((sum, draw) => sum + draw.percent, 0)
  if (totalPercent !== 100) {
    throw new Error(`Draw percentages must sum to 100% (currently ${totalPercent}%)`)
  }

  const drawsToInsert = draws.map((draw, idx) => ({
    org_id: resolvedOrgId,
    project_id: contract.project_id,
    contract_id: contractId,
    draw_number: idx + 1,
    title: draw.title,
    percent_of_contract: draw.percent,
    amount_cents: Math.round((contract.total_cents ?? 0) * draw.percent / 100),
    due_trigger: draw.due_trigger,
    due_date: draw.due_date,
    milestone_id: draw.milestone_id,
    status: "pending",
  }))

  const { data, error } = await supabase
    .from("draw_schedules")
    .insert(drawsToInsert)
    .select("*")

  if (error) {
    throw new Error(`Failed to create draw schedule: ${error.message}`)
  }

  return data
}

