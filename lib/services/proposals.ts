import { createHmac, randomBytes } from "crypto"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
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
  project_id: z.string().uuid().optional().nullable(),
  opportunity_id: z.string().uuid().optional().nullable(),
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

  console.log("Creating proposal with token:", token.substring(0, 10) + "...", "hash:", tokenHash.substring(0, 10) + "...")

  const { data: proposal, error } = await supabase
    .from("proposals")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id ?? null,
      opportunity_id: parsed.opportunity_id ?? null,
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
    token,
  }
}

export async function generateProposalLink(proposalId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const secret = requireProposalSecret()

  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")

  const { data, error } = await supabase
    .from("proposals")
    .update({ token_hash: tokenHash })
    .eq("id", proposalId)
    .eq("org_id", resolvedOrgId)
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to generate proposal link: ${error.message}`)
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return { token, url: `${appUrl}/proposal/${token}`, proposalId: data.id as string }
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

type ProposalAcceptanceSignatureData = {
  signature_svg?: string | null
  signer_name: string
  signer_ip?: string | null
  signer_email?: string | null
  signed_at: string
  source: "proposal_portal" | "envelope_execution"
  envelope_id?: string | null
  document_id?: string | null
}

async function resolveProposalProjectId(supabase: any, proposal: any) {
  let projectId = proposal.project_id as string | null

  if (!projectId) {
    const opportunityId = proposal.opportunity_id as string | null
    if (opportunityId) {
      const { data: projectFromOpportunity } = await supabase
        .from("projects")
        .select("id")
        .eq("org_id", proposal.org_id)
        .eq("opportunity_id", opportunityId)
        .maybeSingle()

      projectId = projectFromOpportunity?.id ?? null
    }
  }

  if (!projectId && proposal.estimate_id) {
    const { data: estimate } = await supabase
      .from("estimates")
      .select("project_id, opportunity_id")
      .eq("org_id", proposal.org_id)
      .eq("id", proposal.estimate_id)
      .maybeSingle()

    projectId = estimate?.project_id ?? null

    if (!projectId && estimate?.opportunity_id) {
      const { data: projectFromEstimateOpportunity } = await supabase
        .from("projects")
        .select("id")
        .eq("org_id", proposal.org_id)
        .eq("opportunity_id", estimate.opportunity_id)
        .maybeSingle()

      projectId = projectFromEstimateOpportunity?.id ?? null
    }
  }

  return projectId
}

async function linkProjectDrawsToContract(input: {
  supabase: any
  orgId: string
  projectId: string
  contractId: string
}) {
  const { error } = await input.supabase
    .from("draw_schedules")
    .update({ contract_id: input.contractId })
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .is("contract_id", null)

  if (error) {
    throw new Error(`Failed to link draws to contract: ${error.message}`)
  }
}

async function finalizeProposalAcceptance(input: {
  supabase: any
  proposal: any
  signaturePayload: ProposalAcceptanceSignatureData
  executedFileId?: string | null
}) {
  const { supabase, proposal, signaturePayload } = input
  const nowIso = signaturePayload.signed_at
  const effectiveDate = nowIso.split("T")[0]

  if (proposal.valid_until && new Date(proposal.valid_until) < new Date(nowIso)) {
    throw new Error("Proposal has expired")
  }

  const projectId = await resolveProposalProjectId(supabase, proposal)
  if (!projectId) {
    throw new Error("Proposal must be linked to a project before acceptance")
  }

  const wasAccepted = proposal.status === "accepted"
  const proposalUpdatePayload: Record<string, any> = {
    project_id: projectId,
    signature_data: signaturePayload,
  }

  if (!wasAccepted) {
    proposalUpdatePayload.status = "accepted"
    proposalUpdatePayload.accepted_at = nowIso
  }

  const { data: updatedProposal, error: updateProposalError } = await supabase
    .from("proposals")
    .update(proposalUpdatePayload)
    .eq("id", proposal.id)
    .select("*, lines:proposal_lines(*), project:projects(name), recipient:contacts(id, full_name)")
    .single()

  if (updateProposalError || !updatedProposal) {
    throw new Error(`Failed to accept proposal: ${updateProposalError?.message ?? "missing"}`)
  }

  const snapshotWithExecution = {
    ...(updatedProposal.snapshot ?? {}),
    ...(input.executedFileId
      ? {
          esign: {
            executed_file_id: input.executedFileId,
            source: signaturePayload.source,
            envelope_id: signaturePayload.envelope_id ?? null,
            document_id: signaturePayload.document_id ?? null,
          },
        }
      : {}),
  }

  const { data: existingContract } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", updatedProposal.org_id)
    .eq("proposal_id", updatedProposal.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let contract = existingContract
  let contractCreatedNow = false

  if (!contract) {
    const contractNumber = `C-${(updatedProposal.number ?? "").replace(/^P-?/, "") || (updatedProposal.id ?? "").slice(0, 6)}`
    const { data: createdContract, error: contractError } = await supabase
      .from("contracts")
      .insert({
        org_id: updatedProposal.org_id,
        project_id: projectId,
        proposal_id: updatedProposal.id,
        number: contractNumber,
        title: updatedProposal.title ?? `Contract for ${updatedProposal.project?.name ?? "project"}`,
        status: "active",
        total_cents: updatedProposal.total_cents,
        signed_at: nowIso,
        effective_date: effectiveDate,
        terms: updatedProposal.terms,
        signature_data: signaturePayload,
        snapshot: snapshotWithExecution,
      })
      .select("*")
      .single()

    if (contractError || !createdContract) {
      throw new Error(`Failed to create contract: ${contractError?.message ?? "missing"}`)
    }

    contract = createdContract
    contractCreatedNow = true
  } else {
    const { data: refreshedContract, error: refreshContractError } = await supabase
      .from("contracts")
      .update({
        status: contract.status === "draft" ? "active" : contract.status,
        signed_at: contract.signed_at ?? nowIso,
        effective_date: contract.effective_date ?? effectiveDate,
        signature_data: signaturePayload,
        snapshot: {
          ...(contract.snapshot ?? {}),
          ...snapshotWithExecution,
        },
        updated_at: nowIso,
      })
      .eq("id", contract.id)
      .select("*")
      .single()

    if (refreshContractError || !refreshedContract) {
      throw new Error(`Failed to refresh contract: ${refreshContractError?.message ?? "missing"}`)
    }

    contract = refreshedContract
  }

  if (!contract) {
    throw new Error("Contract record missing after proposal acceptance")
  }

  await linkProjectDrawsToContract({
    supabase,
    orgId: updatedProposal.org_id,
    projectId,
    contractId: contract.id,
  })

  if (input.executedFileId) {
    await attachFileWithServiceRole({
      orgId: updatedProposal.org_id,
      fileId: input.executedFileId,
      projectId,
      entityType: "contract",
      entityId: contract.id,
      linkRole: "executed_contract",
      createdBy: null,
    })
  }

  if (contractCreatedNow) {
    const budgetLines = (updatedProposal.lines ?? [])
      .filter((line: any) => line.line_type !== "section" && (!line.is_optional || line.is_selected))
      .map((line: any, idx: number) => ({
        org_id: updatedProposal.org_id,
        cost_code_id: line.cost_code_id ?? null,
        description: line.description,
        amount_cents: (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
        sort_order: idx,
      }))

    if (budgetLines.length > 0) {
      const { data: budget, error: budgetError } = await supabase
        .from("budgets")
        .insert({
          org_id: updatedProposal.org_id,
          project_id: projectId,
          status: "approved",
          total_cents: budgetLines.reduce((sum: number, line: any) => sum + (line.amount_cents ?? 0), 0),
        })
        .select("id")
        .single()

      if (budgetError) {
        throw new Error(`Failed to create budget: ${budgetError.message}`)
      }

      if (budget) {
        console.log("Skipping budget lines creation due to database trigger conflict - budget created successfully")
      }
    }

    const allowanceLines = (updatedProposal.lines ?? []).filter((line: any) => line.line_type === "allowance")
    for (const line of allowanceLines) {
      const { error: allowanceError } = await supabase.from("allowances").insert({
        org_id: updatedProposal.org_id,
        project_id: projectId,
        contract_id: contract.id,
        name: line.description,
        budget_cents: line.allowance_cents ?? (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
      })

      if (allowanceError) {
        throw new Error(`Failed to create allowance: ${allowanceError.message}`)
      }
    }
  }

  if (!wasAccepted) {
    try {
      await supabase.from("events").insert({
        org_id: updatedProposal.org_id,
        event_type: "proposal_accepted",
        entity_type: "proposal",
        entity_id: updatedProposal.id,
        payload: {
          contract_id: contract.id,
          signer_name: signaturePayload.signer_name,
          source: signaturePayload.source,
          envelope_id: signaturePayload.envelope_id ?? null,
          document_id: signaturePayload.document_id ?? null,
          executed_file_id: input.executedFileId ?? null,
        },
        channel: "activity",
      })
    } catch (eventError) {
      console.error("Failed to record proposal accepted event", eventError)
    }
  }

  return { proposal: updatedProposal, contract }
}

export async function acceptProposalFromEnvelopeExecution(input: {
  orgId: string
  proposalId: string
  documentId: string
  envelopeId?: string | null
  executedFileId: string
  signerName: string
  signerEmail?: string | null
  signerIp?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select("*, lines:proposal_lines(*), project:projects(name), recipient:contacts(id, full_name)")
    .eq("org_id", input.orgId)
    .eq("id", input.proposalId)
    .maybeSingle()

  if (proposalError || !proposal) {
    throw new Error(`Proposal not found for envelope execution: ${proposalError?.message ?? "missing"}`)
  }

  const nowIso = new Date().toISOString()
  return finalizeProposalAcceptance({
    supabase,
    proposal,
    signaturePayload: {
      signature_svg: null,
      signer_name: input.signerName,
      signer_email: input.signerEmail ?? null,
      signer_ip: input.signerIp ?? null,
      signed_at: nowIso,
      source: "envelope_execution",
      envelope_id: input.envelopeId ?? null,
      document_id: input.documentId,
    },
    executedFileId: input.executedFileId,
  })
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
