import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

type ConversionType =
  | "proposal_acceptance"
  | "bid_award"
  | "estimate_to_proposal"
  | "start_estimating"
  | "activate_opportunity_project"

type ConversionRunStatus = "pending" | "running" | "completed" | "failed"

type ConversionRunInput = {
  orgId: string
  conversionType: ConversionType
  sourceEntityType: string
  sourceEntityId: string
  projectId?: string | null
  triggeredBy?: string | null
  metadata?: Record<string, unknown>
}

type ConversionStepInput = {
  runId: string
  orgId: string
  stepKey: string
  status: ConversionRunStatus
  details?: Record<string, unknown>
  errorMessage?: string | null
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

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown conversion error"
}

async function createConversionRun(input: ConversionRunInput) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("conversion_runs")
    .insert({
      org_id: input.orgId,
      conversion_type: input.conversionType,
      source_entity_type: input.sourceEntityType,
      source_entity_id: input.sourceEntityId,
      project_id: input.projectId ?? null,
      status: "running",
      triggered_by: input.triggeredBy ?? null,
      metadata: input.metadata ?? {},
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create conversion run: ${error?.message ?? "missing"}`)
  }

  return data.id as string
}

async function upsertConversionStep(input: ConversionStepInput) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const payload = {
    org_id: input.orgId,
    conversion_run_id: input.runId,
    step_key: input.stepKey,
    status: input.status,
    details: input.details ?? {},
    error_message: input.errorMessage ?? null,
    started_at: input.status === "running" ? nowIso : undefined,
    completed_at: input.status === "completed" || input.status === "failed" ? nowIso : undefined,
  }

  const { error } = await supabase.from("conversion_run_steps").upsert(payload, {
    onConflict: "conversion_run_id,step_key",
  })

  if (error) {
    throw new Error(`Failed to upsert conversion step ${input.stepKey}: ${error.message}`)
  }
}

async function completeConversionRun(input: {
  runId: string
  orgId: string
  projectId?: string | null
  targetEntityType?: string | null
  targetEntityId?: string | null
  result?: Record<string, unknown>
}) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("conversion_runs")
    .update({
      status: "completed",
      project_id: input.projectId ?? null,
      target_entity_type: input.targetEntityType ?? null,
      target_entity_id: input.targetEntityId ?? null,
      result: input.result ?? {},
      completed_at: new Date().toISOString(),
    })
    .eq("org_id", input.orgId)
    .eq("id", input.runId)

  if (error) {
    throw new Error(`Failed to complete conversion run: ${error.message}`)
  }
}

async function failConversionRun(input: { runId: string; orgId: string; errorMessage: string }) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("conversion_runs")
    .update({
      status: "failed",
      error_message: input.errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("org_id", input.orgId)
    .eq("id", input.runId)
}

async function resolveProposalProjectId(supabase: ReturnType<typeof createServiceSupabaseClient>, proposal: any) {
  let projectId = proposal.project_id as string | null

  if (!projectId) {
    const opportunityId = proposal.opportunity_id as string | null
    if (opportunityId) {
      const { data: projectFromOpportunity, error } = await supabase
        .from("projects")
        .select("id")
        .eq("org_id", proposal.org_id)
        .eq("opportunity_id", opportunityId)
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to resolve project from opportunity: ${error.message}`)
      }

      projectId = projectFromOpportunity?.id ?? null
    }
  }

  if (!projectId && proposal.estimate_id) {
    const { data: estimate, error } = await supabase
      .from("estimates")
      .select("project_id, opportunity_id")
      .eq("org_id", proposal.org_id)
      .eq("id", proposal.estimate_id)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to resolve estimate context: ${error.message}`)
    }

    projectId = estimate?.project_id ?? null

    if (!projectId && estimate?.opportunity_id) {
      const { data: projectFromEstimateOpportunity, error: projectError } = await supabase
        .from("projects")
        .select("id")
        .eq("org_id", proposal.org_id)
        .eq("opportunity_id", estimate.opportunity_id)
        .maybeSingle()

      if (projectError) {
        throw new Error(`Failed to resolve project from estimate opportunity: ${projectError.message}`)
      }

      projectId = projectFromEstimateOpportunity?.id ?? null
    }
  }

  return projectId
}

export async function runProposalAcceptanceConversion(input: {
  orgId: string
  proposalId: string
  signaturePayload: ProposalAcceptanceSignatureData
  executedFileId?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select("id, org_id, project_id, opportunity_id, estimate_id, status, number, title, valid_until")
    .eq("org_id", input.orgId)
    .eq("id", input.proposalId)
    .maybeSingle()

  if (proposalError || !proposal) {
    throw new Error(`Proposal not found for conversion: ${proposalError?.message ?? "missing"}`)
  }

  const runId = await createConversionRun({
    orgId: input.orgId,
    conversionType: "proposal_acceptance",
    sourceEntityType: "proposal",
    sourceEntityId: input.proposalId,
    metadata: {
      source: input.signaturePayload.source,
      envelope_id: input.signaturePayload.envelope_id ?? null,
      document_id: input.signaturePayload.document_id ?? null,
      executed_file_id: input.executedFileId ?? null,
    },
  })

  try {
    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "resolve_project",
      status: "running",
      details: {
        proposal_id: input.proposalId,
      },
    })

    const projectId = await resolveProposalProjectId(supabase, proposal)
    if (!projectId) {
      throw new Error("Proposal must be linked to a preconstruction project before acceptance")
    }

    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "resolve_project",
      status: "completed",
      details: {
        project_id: projectId,
      },
    })

    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_acceptance",
      status: "running",
      details: {
        project_id: projectId,
      },
    })

    const { data: rpcResult, error: rpcError } = await supabase.rpc("run_proposal_acceptance_conversion", {
      p_org_id: input.orgId,
      p_proposal_id: input.proposalId,
      p_project_id: projectId,
      p_signature_data: input.signaturePayload,
      p_executed_file_id: input.executedFileId ?? null,
    })

    if (rpcError || !rpcResult) {
      throw new Error(`Failed to run proposal acceptance conversion: ${rpcError?.message ?? "missing"}`)
    }

    const result = rpcResult as {
      proposal_id: string
      project_id: string
      contract_id: string
      budget_id: string
      contract_created_now: boolean
      budget_created_now: boolean
      allowance_count: number
    }

    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_acceptance",
      status: "completed",
      details: result,
    })

    const [{ data: updatedProposal, error: updatedProposalError }, { data: contract, error: contractError }] = await Promise.all([
      supabase
        .from("proposals")
        .select("*, lines:proposal_lines(*), project:projects(name), recipient:contacts(id, full_name)")
        .eq("org_id", input.orgId)
        .eq("id", input.proposalId)
        .single(),
      supabase
        .from("contracts")
        .select("*")
        .eq("org_id", input.orgId)
        .eq("id", result.contract_id)
        .single(),
    ])

    if (updatedProposalError || !updatedProposal) {
      throw new Error(`Failed to load converted proposal: ${updatedProposalError?.message ?? "missing"}`)
    }

    if (contractError || !contract) {
      throw new Error(`Failed to load converted contract: ${contractError?.message ?? "missing"}`)
    }

    await completeConversionRun({
      runId,
      orgId: input.orgId,
      projectId: result.project_id,
      targetEntityType: "contract",
      targetEntityId: result.contract_id,
      result,
    })

    await recordEvent({
      orgId: input.orgId,
      eventType: "proposal_accepted",
      entityType: "proposal",
      entityId: updatedProposal.id as string,
      payload: {
        contract_id: result.contract_id,
        budget_id: result.budget_id,
        project_id: result.project_id,
        signer_name: input.signaturePayload.signer_name,
        source: input.signaturePayload.source,
        envelope_id: input.signaturePayload.envelope_id ?? null,
        document_id: input.signaturePayload.document_id ?? null,
        executed_file_id: input.executedFileId ?? null,
        conversion_run_id: runId,
      },
    })

    return {
      proposal: updatedProposal,
      contract,
      conversionRunId: runId,
      result,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_acceptance",
      status: "failed",
      errorMessage: message,
    }).catch(() => {})
    await failConversionRun({ runId, orgId: input.orgId, errorMessage: message }).catch(() => {})
    throw error
  }
}

export async function runBidAwardConversion(input: {
  orgId: string
  bidSubmissionId: string
  awardedBy?: string | null
  notes?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const { data: submission, error: submissionError } = await supabase
    .from("bid_submissions")
    .select("id, org_id, bid_invite_id")
    .eq("org_id", input.orgId)
    .eq("id", input.bidSubmissionId)
    .maybeSingle()

  if (submissionError || !submission) {
    throw new Error(`Bid submission not found for conversion: ${submissionError?.message ?? "missing"}`)
  }

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id")
    .eq("org_id", input.orgId)
    .eq("id", submission.bid_invite_id)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error(`Bid invite not found for conversion: ${inviteError?.message ?? "missing"}`)
  }

  const { data: bidPackage, error: packageError } = await supabase
    .from("bid_packages")
    .select("id, project_id")
    .eq("org_id", input.orgId)
    .eq("id", invite.bid_package_id)
    .maybeSingle()

  if (packageError || !bidPackage) {
    throw new Error(`Bid package not found for conversion: ${packageError?.message ?? "missing"}`)
  }

  const runId = await createConversionRun({
    orgId: input.orgId,
    conversionType: "bid_award",
    sourceEntityType: "bid_submission",
    sourceEntityId: input.bidSubmissionId,
    projectId: bidPackage.project_id,
    triggeredBy: input.awardedBy ?? null,
    metadata: {
      bid_package_id: bidPackage.id,
      notes: input.notes ?? null,
    },
  })

  try {
    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_award",
      status: "running",
      details: {
        bid_package_id: bidPackage.id,
        project_id: bidPackage.project_id,
      },
    })

    const { data: rpcResult, error: rpcError } = await supabase.rpc("run_bid_award_conversion", {
      p_org_id: input.orgId,
      p_bid_submission_id: input.bidSubmissionId,
      p_awarded_by: input.awardedBy ?? null,
      p_notes: input.notes ?? null,
    })

    if (rpcError || !rpcResult) {
      throw new Error(`Failed to run bid award conversion: ${rpcError?.message ?? "missing"}`)
    }

    const result = rpcResult as {
      award_id: string
      commitment_id: string
      bid_package_id: string
      project_vendor_id?: string | null
    }

    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_award",
      status: "completed",
      details: result,
    })

    const { data: award, error: awardError } = await supabase
      .from("bid_awards")
      .select("id, org_id, bid_package_id, awarded_submission_id, awarded_commitment_id, awarded_by, awarded_at, notes")
      .eq("org_id", input.orgId)
      .eq("id", result.award_id)
      .single()

    if (awardError || !award) {
      throw new Error(`Failed to load bid award after conversion: ${awardError?.message ?? "missing"}`)
    }

    await completeConversionRun({
      runId,
      orgId: input.orgId,
      projectId: bidPackage.project_id,
      targetEntityType: "commitment",
      targetEntityId: result.commitment_id,
      result,
    })

    await recordEvent({
      orgId: input.orgId,
      actorId: input.awardedBy ?? null,
      eventType: "bid_awarded",
      entityType: "bid_package",
      entityId: result.bid_package_id,
      payload: {
        bid_package_id: result.bid_package_id,
        bid_submission_id: input.bidSubmissionId,
        commitment_id: result.commitment_id,
        project_vendor_id: result.project_vendor_id ?? null,
        conversion_run_id: runId,
      },
    })

    if (input.awardedBy) {
      await recordAudit({
        orgId: input.orgId,
        actorId: input.awardedBy,
        action: "insert",
        entityType: "bid_award",
        entityId: award.id as string,
        after: award,
        source: "conversion_engine",
      })
    }

    return {
      awardId: result.award_id,
      commitmentId: result.commitment_id,
      conversionRunId: runId,
      result,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    await upsertConversionStep({
      runId,
      orgId: input.orgId,
      stepKey: "transactional_award",
      status: "failed",
      errorMessage: message,
    }).catch(() => {})
    await failConversionRun({ runId, orgId: input.orgId, errorMessage: message }).catch(() => {})
    throw error
  }
}
