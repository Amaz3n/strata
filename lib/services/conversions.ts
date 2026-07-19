import type { AcceptedOptions } from "@/lib/financials/estimate-totals"
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
  acceptedAlternateIds?: string[]
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
      p_accepted_alternate_ids: input.acceptedAlternateIds ?? [],
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

export async function convertExecutedProspectToProject({
  prospectId,
  estimateId,
  projectInput,
  triggeredBy,
}: {
  prospectId: string
  estimateId: string
  projectInput: {
    name: string
    start_date?: string | null
    end_date?: string | null
    property_type?: "residential" | "commercial" | "production"
    project_type?: "new_construction" | "remodel" | "addition" | "renovation" | "repair"
    description?: string | null
  }
  triggeredBy?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  // 1. Get prospect details
  const { data: prospect, error: prospectError } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", prospectId)
    .maybeSingle()

  if (prospectError || !prospect) {
    throw new Error(`Prospect not found: ${prospectError?.message ?? "missing"}`)
  }

  // 2. Validate estimate is executed
  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select("*, items:estimate_items(*)")
    .eq("id", estimateId)
    .eq("prospect_id", prospectId)
    .maybeSingle()

  if (estimateError || !estimate) {
    throw new Error(`Estimate not found: ${estimateError?.message ?? "missing"}`)
  }

  if (estimate.status !== "executed") {
    throw new Error(`Estimate must be executed before converting to a project. Current status: ${estimate.status}`)
  }

  // The client may have accepted optional add-ons at signing; the executed
  // agreement is base + accepted options, so the contract, project value, and
  // budget must all be built from that scope — not the base document.
  const acceptedOptions = ((estimate.metadata as Record<string, unknown> | null)?.accepted_options ??
    null) as AcceptedOptions | null
  const acceptedOptionalIds = new Set(acceptedOptions?.ids ?? [])
  const contractTotalCents: number = acceptedOptions?.accepted_total_cents ?? estimate.total_cents ?? 0
  const contractedItems = ((estimate.items ?? []) as any[]).filter(
    (item) =>
      item.item_type === "line" &&
      (item.metadata?.is_optional !== true || acceptedOptionalIds.has(item.id)),
  )

  // 3. Idempotency Check: check if project already exists for this prospect
  const { data: existingProject, error: projectLookupError } = await supabase
    .from("projects")
    .select("id")
    .eq("prospect_id", prospectId)
    .maybeSingle()

  if (existingProject) {
    // Already converted! Let's load active contract and return to be idempotent
    const { data: contract } = await supabase
      .from("contracts")
      .select("*")
      .eq("project_id", existingProject.id)
      .eq("status", "active")
      .maybeSingle()

    return {
      projectId: existingProject.id,
      contractId: contract?.id || null,
      alreadyConverted: true,
    }
  }

  // Create a conversion run record for audit and tracking
  const runId = await createConversionRun({
    orgId: prospect.org_id,
    conversionType: "activate_opportunity_project",
    sourceEntityType: "prospect",
    sourceEntityId: prospectId,
    metadata: {
      estimate_id: estimateId,
      triggered_by: triggeredBy || null,
    },
  })

  try {
    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "promote_contacts",
      status: "running",
      details: { prospect_id: prospectId },
    })

    // 4. Promote prospect contacts
    const { data: prospectContacts, error: pcError } = await supabase
      .from("prospect_contacts")
      .select("*")
      .eq("prospect_id", prospectId)

    if (pcError) {
      throw new Error(`Failed to load prospect contacts: ${pcError.message}`)
    }

    const { createContact } = await import("@/lib/services/contacts")

    let primaryPromotedContactId: string | null = null
    const promotedContactsMap = new Map<string, string>()

    for (const pc of prospectContacts || []) {
      let promotedId = pc.promoted_contact_id

      if (!promotedId && pc.email) {
        // Look up by email in Directory to prevent duplicates
        const { data: existingDirContact } = await supabase
          .from("contacts")
          .select("id")
          .eq("org_id", prospect.org_id)
          .eq("email", pc.email)
          .maybeSingle()

        if (existingDirContact) {
          promotedId = existingDirContact.id
        }
      }

      if (!promotedId) {
        const newContact = await createContact({
          input: {
            full_name: pc.full_name,
            email: pc.email || undefined,
            phone: pc.phone || undefined,
            role: pc.role || undefined,
            contact_type: "client",
          },
          orgId: prospect.org_id,
        })
        promotedId = newContact.id
      }

      // Update the prospect_contact link
      await supabase
        .from("prospect_contacts")
        .update({ promoted_contact_id: promotedId, updated_at: new Date().toISOString() })
        .eq("id", pc.id)

      promotedContactsMap.set(pc.id, promotedId)

      if (pc.is_primary) {
        primaryPromotedContactId = promotedId
      }
    }

    // Fallback if no primary contact was marked primary: use the first promoted contact
    if (!primaryPromotedContactId && prospectContacts && prospectContacts.length > 0) {
      primaryPromotedContactId = promotedContactsMap.get(prospectContacts[0].id) || null
    }

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "promote_contacts",
      status: "completed",
      details: { primary_promoted_contact_id: primaryPromotedContactId },
    })

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "create_project",
      status: "running",
    })

    // 5. Create project
    const { createProject } = await import("@/lib/services/projects")

    const createdProject = await createProject({
      input: {
        name: projectInput.name,
        status: "active",
        start_date: projectInput.start_date || null,
        end_date: projectInput.end_date || null,
        location: prospect.jobsite_location || undefined,
        client_id: primaryPromotedContactId || undefined,
        property_type: projectInput.property_type,
        project_type: projectInput.project_type || (prospect.project_type === "new_construction" || prospect.project_type === "remodel" || prospect.project_type === "addition" || prospect.project_type === "renovation" || prospect.project_type === "repair" ? prospect.project_type : "remodel"),
        description: projectInput.description || prospect.notes || undefined,
        total_value: Math.round(contractTotalCents / 100),
        prospect_id: prospectId,
      },
      orgId: prospect.org_id,
    })

    const projectId = createdProject.id

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "create_project",
      status: "completed",
      details: { project_id: projectId },
    })

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "link_precon_contexts",
      status: "running",
    })

    // 6. Link precon context to the new project
    // Update estimates
    await supabase
      .from("estimates")
      .update({ project_id: projectId, updated_at: new Date().toISOString() })
      .eq("prospect_id", prospectId)

    // Update bid packages
    await supabase
      .from("bid_packages")
      .update({ project_id: projectId, updated_at: new Date().toISOString() })
      .eq("prospect_id", prospectId)

    // Update files
    await supabase
      .from("files")
      .update({ project_id: projectId, updated_at: new Date().toISOString() })
      .eq("prospect_id", prospectId)

    // Update documents
    await supabase
      .from("documents")
      .update({ project_id: projectId, updated_at: new Date().toISOString() })
      .eq("prospect_id", prospectId)

    // Update envelopes
    await supabase
      .from("envelopes")
      .update({ project_id: projectId, updated_at: new Date().toISOString() })
      .eq("prospect_id", prospectId)

    // Move files under `/prospects/${prospectId}` to `/projects/${projectId}` in folder_path
    const { data: filesToMove } = await supabase
      .from("files")
      .select("id, folder_path")
      .eq("prospect_id", prospectId)

    for (const f of filesToMove || []) {
      if (f.folder_path && f.folder_path.startsWith(`/prospects/${prospectId}`)) {
        const nextPath = f.folder_path.replace(`/prospects/${prospectId}`, `/projects/${projectId}`)
        await supabase
          .from("files")
          .update({ folder_path: nextPath, updated_at: new Date().toISOString() })
          .eq("id", f.id)
      }
    }

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "link_precon_contexts",
      status: "completed",
    })

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "create_contract_and_budget",
      status: "running",
    })

    // 7. Create contract from executed estimate
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .insert({
        org_id: prospect.org_id,
        project_id: projectId,
        title: `${createdProject.name} Contract`,
        status: "active",
        total_cents: contractTotalCents,
        currency: "usd",
        signed_at: estimate.executed_at,
        effective_date: estimate.executed_at ? estimate.executed_at.substring(0, 10) : new Date().toISOString().substring(0, 10),
        terms: estimate.metadata?.terms || null,
        signature_data: estimate.signature_data,
        snapshot: {
          estimate_id: estimateId,
          esign: estimate.executed_file_id ? {
            executed_file_id: estimate.executed_file_id,
            source: estimate.signature_data?.builder?.source || "estimate_execution",
            envelope_id: estimate.signature_envelope_id || null,
            document_id: estimate.signature_document_id || null,
          } : undefined
        }
      })
      .select("*")
      .single()

    if (contractError || !contract) {
      throw new Error(`Failed to create contract from estimate: ${contractError?.message}`)
    }

    // Link the executed PDF file to the contract
    if (estimate.executed_file_id) {
      await supabase.from("file_links").insert({
        org_id: prospect.org_id,
        file_id: estimate.executed_file_id,
        project_id: projectId,
        entity_type: "contract",
        entity_id: contract.id,
        link_role: "executed_contract",
      })
    }

    // Create budget lines from the contracted estimate items (base + accepted
    // add-ons). Budget lines are the builder's cost basis: qty × unit cost,
    // with markup (profit) excluded — so the budget header must be the sum of
    // its lines, not the client-facing contract price.
    const budgetLines = contractedItems.map((item: any, idx: number) => ({
      org_id: prospect.org_id,
      cost_code_id: item.cost_code_id || null,
      description: item.description,
      amount_cents: (item.unit_cost_cents || 0) * (item.quantity || 1),
      sort_order: item.sort_order ?? idx,
      metadata: {
        source: "estimate_execution",
        source_estimate_id: estimateId,
        source_estimate_item_id: item.id,
        item_type: item.item_type,
        ...(item.metadata?.is_optional === true ? { accepted_optional: true } : {}),
        ...(item.metadata?.is_allowance === true ? { is_allowance: true } : {}),
      }
    }))
    const budgetTotalCents = budgetLines.reduce((sum, line) => sum + line.amount_cents, 0)

    const { data: budget, error: budgetError } = await supabase
      .from("budgets")
      .insert({
        org_id: prospect.org_id,
        project_id: projectId,
        status: "approved",
        total_cents: budgetTotalCents,
        currency: "usd",
        metadata: {
          source: "estimate_execution",
          source_estimate_id: estimateId,
          source_contract_id: contract.id,
          contract_total_cents: contractTotalCents,
        }
      })
      .select("*")
      .single()

    if (budgetError || !budget) {
      throw new Error(`Failed to create budget from estimate: ${budgetError?.message}`)
    }

    if (budgetLines.length > 0) {
      const { error: blError } = await supabase
        .from("budget_lines")
        .insert(budgetLines.map((line) => ({ ...line, budget_id: budget.id })))
      if (blError) {
        throw new Error(`Failed to create budget lines: ${blError.message}`)
      }
    }

    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "create_contract_and_budget",
      status: "completed",
      details: { contract_id: contract.id, budget_id: budget.id },
    })

    // Update prospect to won status
    await supabase
      .from("prospects")
      .update({
        status: "won",
        won_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", prospectId)

    // Mark estimate as converted
    await supabase
      .from("estimates")
      .update({
        status: "converted_to_project",
        updated_at: new Date().toISOString(),
      })
      .eq("id", estimateId)

    await completeConversionRun({
      runId,
      orgId: prospect.org_id,
      projectId,
      targetEntityType: "project",
      targetEntityId: projectId,
      result: {
        project_id: projectId,
        contract_id: contract.id,
        budget_id: budget.id,
        promoted_contacts_count: prospectContacts?.length ?? 0,
      },
    })

    await recordEvent({
      orgId: prospect.org_id,
      actorId: triggeredBy || null,
      eventType: "project_created",
      entityType: "project",
      entityId: projectId,
      payload: {
        name: createdProject.name,
        prospect_id: prospectId,
        estimate_id: estimateId,
        contract_id: contract.id,
        budget_id: budget.id,
        conversion_run_id: runId,
      },
    })

    return {
      projectId,
      contractId: contract.id,
      budgetId: budget.id,
      conversionRunId: runId,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    await upsertConversionStep({
      runId,
      orgId: prospect.org_id,
      stepKey: "create_contract_and_budget",
      status: "failed",
      errorMessage: message,
    }).catch(() => {})
    await failConversionRun({ runId, orgId: prospect.org_id, errorMessage: message }).catch(() => {})
    throw error
  }
}
