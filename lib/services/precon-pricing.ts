import "server-only";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  authorizePreconWorkspaceWrite,
  authorizePreconWorkspaceRead,
  getPreconWorkspace,
} from "./precon-workspace";
import { EMPTY_PRECON_BRIEF } from "@/lib/precon/workspace";
import { pricingBriefVersion } from "@/lib/precon/brief-revision";
import {
  pricingWorksheetSchema,
  pricingRequestSchema,
  scopeSignature,
  worksheetEstimateLines,
  worksheetTotals,
  worksheetQuoteIssues,
  type PricingWorksheet,
} from "@/lib/precon/pricing-worksheet";
import {
  createBidPackage,
  beginBidScopeRevision,
  createBidAddendum,
  getBidPackage,
  saveBidScopeItems,
  listProspectBidQuotes,
  listBidScopeItems,
  listBidSubmissions,
  listBidInvites,
  selectBidForPricing,
  updateBidPackage,
  bulkCreateBidInvites,
  createManualBidSubmission,
  resendBidInvite,
} from "./bids";
import { createEstimate, createEstimateVersion } from "./estimates";
import { estimateInputSchema } from "@/lib/validation/estimates";
import { recordAudit } from "./audit";

export async function savePricingWorksheet(
  prospectId: string,
  input: unknown,
  expectedVersion: number,
) {
  const worksheet = pricingWorksheetSchema.parse(input);
  z.number().int().nonnegative().parse(expectedVersion);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  const { service, orgId, userId } = context;
  if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
    throw new Error("Closed deals are read-only. Reopen a lost deal or continue in the active project.");
  const previous = await service
    .from("precon_workspaces")
    .select("brief,version")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .maybeSingle();
  if (previous.error) throw new Error("Unable to load the pricing worksheet.");
  if ((previous.data?.version ?? 0) !== expectedVersion)
    throw new Error(
      "Pricing or job details changed in another session. Review latest saved pricing to keep and merge your edits.",
    );
  const prior = previous.data?.brief?.pricing_worksheet as
    | PricingWorksheet
    | undefined;
  // Validate linked objects against this opportunity, never just against the tenant.
  const packages = await Promise.all(
    worksheet.requests.map((request) => getBidPackage(request.package_id)),
  );
  for (const pkg of packages)
    assertPackageParent(pkg, prospectId, context.projectId);
  if (worksheet.rows.some((row) => row.cost_code_id)) {
    const ids = [
      ...new Set(
        worksheet.rows.flatMap((row) =>
          row.cost_code_id ? [row.cost_code_id] : [],
        ),
      ),
    ];
    const result = await context.supabase
      .from("cost_codes")
      .select("id")
      .eq("org_id", orgId)
      .in("id", ids);
    if (result.error || result.data?.length !== ids.length)
      throw new Error("Choose cost codes from this organization.");
  }
  if (worksheet.source_estimate_id) {
    const source = await context.supabase
      .from("estimates")
      .select("id")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .eq("id", worksheet.source_estimate_id)
      .maybeSingle();
    if (source.error || !source.data)
      throw new Error("The source estimate does not belong to this lead.");
  }
  const selected = worksheet.requests.some((request) => request.quote)
    ? await listProspectBidQuotes(prospectId)
    : [];
  for (const request of worksheet.requests) {
    const original = prior?.requests.find(
      (item) => item.package_id === request.package_id,
    );
    if (original) {
      if (JSON.stringify(original.row_ids) !== JSON.stringify(request.row_ids))
        throw new Error(
          "Unlink this request before changing the scope items it covers.",
        );
      request.scope_signature = original.scope_signature;
    } else {
      request.scope_signature = scopeSignature(
        worksheet.rows.filter((row) => request.row_ids.includes(row.id)),
      );
    }
    if (!request.quote) continue;
    // Retain a stale cost for working purposes, but never allow it to be changed or
    // issued as current. Publication validates every quote again below.
    if (original && JSON.stringify(original) === JSON.stringify(request))
      continue;
    const canonical = selected.find(
      (quote) =>
        quote.bid_package_id === request.package_id &&
        quote.pricing_decision_id === request.quote!.pricing_decision_id,
    );
    if (!canonical)
      throw new Error(
        "Select a current quote before using it in the worksheet.",
      );
    request.quote = pricingRequestSchema.parse({
      ...request,
      quote: canonical,
    }).quote;
  }
  const brief = {
    ...(previous.data?.brief ?? EMPTY_PRECON_BRIEF),
    pricing_worksheet: worksheet,
  };
  // A worksheet save is not a change to the job's governing scope/documents.
  brief.pricing_revision = pricingBriefVersion(
    previous.data?.brief ?? EMPTY_PRECON_BRIEF,
    expectedVersion,
  );
  const values = { brief, version: expectedVersion + 1, updated_by: userId };
  const result =
    expectedVersion === 0
      ? await service
          .from("precon_workspaces")
          .insert({ ...values, org_id: orgId, prospect_id: prospectId })
          .select("version")
          .single()
      : await service
          .from("precon_workspaces")
          .update(values)
          .eq("org_id", orgId)
          .eq("prospect_id", prospectId)
          .eq("version", expectedVersion)
          .select("version")
          .maybeSingle();
  if (result.error?.code === "23505" || (!result.error && !result.data))
    throw new Error(
      "Pricing changed in another session. Review latest saved pricing before saving.",
    );
  if (result.error)
    throw new Error(`Unable to save pricing: ${result.error.message}`);
  await recordAudit({
    orgId,
    actorId: userId,
    action: expectedVersion ? "update" : "insert",
    entityType: "prospect",
    entityId: prospectId,
    after: { pricing_worksheet: worksheet, version: expectedVersion + 1 },
  });
  return { worksheet, version: expectedVersion + 1 };
}

function assertPackageParent(
  pkg: { prospect_id?: string | null; project_id?: string | null },
  prospectId: string,
  projectId?: string,
) {
  if (
    pkg.prospect_id !== prospectId &&
    (!projectId || pkg.project_id !== projectId)
  )
    throw new Error("This quote request does not belong to this lead.");
}

async function pricingPackageContext(
  prospectId: string,
  packageId: string,
  write: boolean,
) {
  z.string().uuid().parse(packageId);
  const { getProspect } = await import("./prospects");
  const [workspace, pkg, prospect] = await Promise.all([
    getPreconWorkspace(prospectId),
    getBidPackage(packageId),
    getProspect(prospectId),
  ]);
  // Read authorization is checked by getPreconWorkspace; resolve ownership via
  // the prospect instead of trusting a project ID from the browser.
  assertPackageParent(pkg, prospectId, prospect?.project_id ?? undefined);
  if (write) {
    const context = await authorizePreconWorkspaceWrite(prospectId);
    if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
      throw new Error("Closed deals are read-only. Reopen a lost deal or continue in the active project.");
  }
  return { workspace, pkg };
}

export async function getPricingQuotes(prospectId: string, packageId: string) {
  z.string().uuid().parse(packageId);
  // Quote inspection needs authorization and the package, not the full brief and decision history.
  const [context, pkg] = await Promise.all([
    authorizePreconWorkspaceRead(prospectId),
    getBidPackage(packageId),
  ]);
  assertPackageParent(pkg, prospectId, context.projectId);
  const { listAttachments } = await import("./file-links");
  const [scope, submissions, invites, attachments] = await Promise.all([
    listBidScopeItems(packageId),
    listBidSubmissions(packageId),
    listBidInvites(packageId),
    listAttachments("bid_package", packageId),
  ]);
  return {
    pkg,
    scope,
    submissions,
    invites,
    fileIds: attachments.map((link) => link.file_id),
  };
}

export async function createPricingRequest(
  prospectId: string,
  input: unknown,
  expectedVersion: number,
) {
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(200),
      row_ids: z.array(z.string().uuid()).min(1).max(200),
      due_at: z.string().datetime().nullable(),
      instructions: z.string().max(12000),
    })
    .parse(input);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
    throw new Error("Closed deals cannot request quotes. Continue in the active project.");
  const workspace = await getPreconWorkspace(prospectId);
  if (workspace.version !== expectedVersion || !workspace.pricing)
    throw new Error("Save the latest worksheet before requesting quotes.");
  const worksheet = workspace.pricing;
  const rows = worksheet.rows.filter((row) => parsed.row_ids.includes(row.id));
  if (
    rows.length !== parsed.row_ids.length ||
    worksheet.requests.some((request) =>
      request.row_ids.some((id) => parsed.row_ids.includes(id)),
    )
  )
    throw new Error("Choose unlinked scope items for this request.");
  if (
    new Set(rows.map((row) => row.is_optional)).size > 1 ||
    rows.some((row) => row.option_group)
  )
    throw new Error("Request base scope and alternatives separately.");
  const pkg = await createBidPackage({
    input: {
      prospect_id: prospectId,
      title: parsed.title,
      scope: rows
        .map((row) => `${row.description}${row.notes ? `\n${row.notes}` : ""}`)
        .join("\n\n"),
      instructions: parsed.instructions,
      due_at: parsed.due_at,
      mode: "quote",
    },
  });
  // Link first, so a later scope-save failure leaves a recoverable draft request.
  const saved = await savePricingWorksheet(
    prospectId,
    {
      ...worksheet,
      requests: [
        ...worksheet.requests,
        {
          package_id: pkg.id,
          row_ids: parsed.row_ids,
          scope_signature: scopeSignature(rows),
          quote: null,
        },
      ],
    },
    expectedVersion,
  );
  await saveBidScopeItems({
    input: {
      bid_package_id: pkg.id,
      items: rows.map((row) => ({
        description: row.description,
        details: row.notes,
        quantity: row.quantity || null,
        unit: row.unit,
        cost_code_id: row.cost_code_id,
        item_type: "base",
      })),
    },
  });
  return { ...saved, packageId: pkg.id };
}

export async function selectPricingQuote(
  prospectId: string,
  packageId: string,
  input: unknown,
  expectedVersion: number,
) {
  const { workspace } = await pricingPackageContext(
    prospectId,
    packageId,
    true,
  );
  if (workspace.version !== expectedVersion || !workspace.pricing)
    throw new Error(
      "Save or reload the latest worksheet before choosing a quote.",
    );
  const request = workspace.pricing.requests.find(
    (item) => item.package_id === packageId,
  );
  if (!request)
    throw new Error("Link this request to scope before choosing a quote.");
  if (
    scopeSignature(
      workspace.pricing.rows.filter((row) => request.row_ids.includes(row.id)),
    ) !== request.scope_signature
  )
    throw new Error(
      "The requested scope has changed. Review its revision before selecting pricing.",
    );
  const submissionId = z
    .object({ bid_submission_id: z.string().uuid() })
    .parse(input).bid_submission_id;
  const submissions = await listBidSubmissions(packageId);
  if (!submissions.some((item) => item.id === submissionId))
    throw new Error("The quote does not belong to this request.");
  const decision = await selectBidForPricing({ input });
  const quote = (await listProspectBidQuotes(prospectId)).find(
    (item) => item.pricing_decision_id === decision.id,
  );
  if (!quote)
    throw new Error(
      "The selected quote is no longer available. Reload the request.",
    );
  return savePricingWorksheet(
    prospectId,
    {
      ...workspace.pricing,
      requests: workspace.pricing.requests.map((item) =>
        item.package_id === packageId ? { ...item, quote } : item,
      ),
    },
    expectedVersion,
  );
}

export async function sendPricingRequest(
  prospectId: string,
  packageId: string,
  input: unknown,
) {
  const { pkg } = await pricingPackageContext(prospectId, packageId, true);
  if (["closed", "awarded", "cancelled"].includes(pkg.status))
    throw new Error("This request is closed to invitations.");
  const invites = z
    .array(
      z.object({
        company_id: z.string().uuid().optional(),
        contact_id: z.string().uuid().optional(),
        invite_email: z.string().email().optional(),
        company_name: z.string().optional(),
      }),
    )
    .min(1)
    .parse(input);
  if (pkg.status === "draft")
    await updateBidPackage({
      bidPackageId: packageId,
      input: { status: "open" },
    });
  return bulkCreateBidInvites({
    input: { bid_package_id: packageId, invites, send_emails: true },
  });
}

export async function resendPricingInvitation(
  prospectId: string,
  packageId: string,
  inviteId: string,
) {
  const { pkg } = await pricingPackageContext(prospectId, packageId, true);
  if (["closed", "awarded", "cancelled"].includes(pkg.status))
    throw new Error("This request is closed to invitations.");
  if (
    !(await listBidInvites(packageId)).some((invite) => invite.id === inviteId)
  )
    throw new Error("This invitation does not belong to the request.");
  return resendBidInvite({ inviteId });
}

export async function recordPricingQuote(
  prospectId: string,
  packageId: string,
  input: unknown,
) {
  const { pkg } = await pricingPackageContext(prospectId, packageId, true);
  const parsed = z
    .object({
      company_id: z.string().uuid(),
      total_cents: z.number().int().nonnegative(),
      valid_until: z.string().date().nullable(),
      exclusions: z.string().max(12000),
      notes: z.string().max(12000),
    })
    .parse(input);
  if (pkg.status === "draft")
    await updateBidPackage({
      bidPackageId: packageId,
      input: { status: "open" },
    });
  const scope = await listBidScopeItems(packageId);
  // A received lump sum covers the requested scope unless exclusions are entered.
  // Exclusions still require explicit disposition in the pricing decision panel.
  return createManualBidSubmission({
    input: {
      ...parsed,
      bid_package_id: packageId,
      items: scope.map((item, index) => ({
        bid_scope_item_id: item.id,
        description: item.description,
        response: "priced",
        amount_cents: index === 0 ? parsed.total_cents : 0,
        notes: "Included in vendor lump sum",
      })),
    },
  });
}

const DEFAULT_PAYMENT_TERMS =
  "10% deposit on signing. Progress payments billed monthly for work completed, due within 15 days.";
const DEFAULT_ALLOWANCE_POLICY =
  "Allowances are reconciled against actual selections by change order; differences are billed or credited with the same markup.";

/**
 * One document, prepared from the worksheet. A soft price goes out as a budget
 * (a range, approval only); a firm one as the construction agreement. The
 * worksheet is the only place a price is edited, so each send is a snapshot of it.
 */
export async function prepareDealDocument(
  prospectId: string,
  kind: "budget" | "agreement",
  input: unknown,
  expectedVersion: number,
) {
  const context = await authorizePreconWorkspaceWrite(prospectId);
  if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
    throw new Error("Closed deals cannot send a price. Continue in the active project.");
  const workspace = await getPreconWorkspace(prospectId);
  if (workspace.version !== expectedVersion || !workspace.pricing)
    throw new Error("Save the latest worksheet before sending a price.");
  const worksheet = workspace.pricing;
  if (!worksheet.rows.length || worksheetTotals(worksheet).unpriced)
    throw new Error(
      "Price each scope item or carry an allowance before preparing the client proposal.",
    );
  const issues = worksheetQuoteIssues(
    worksheet,
    await listProspectBidQuotes(prospectId),
  );
  if (issues.length) throw new Error(issues.join("\n"));
  if (context.projectId && worksheet.rows.some(row => row.metadata.takeoff)) {
    const { getConditionRollup } = await import("./takeoff");
    const measurements = await getConditionRollup({ project_id: context.projectId });
    for (const row of worksheet.rows) {
      const source = row.metadata.takeoff as { condition_id?: string; measured_quantity?: number; detached?: boolean; evidence_only?: boolean } | undefined;
      if (!source?.condition_id || source.detached) continue;
      const measurement = measurements.find(item => item.condition.id === source.condition_id);
      if (!measurement) continue; // Deleted sources retain the frozen estimate quantity.
      if (measurement.pending_review_count || measurement.unscaled_markup_count) throw new Error(`Review revised measurements for ${row.description} before sending a price.`);
      const manualOverride = !source.evidence_only && Math.abs(row.quantity - (source.measured_quantity ?? 0)) > 0.01;
      if (!manualOverride && Math.abs(measurement.effective_quantity - (source.measured_quantity ?? 0)) > 0.01) throw new Error(`Plans changed for ${row.description}. Review and apply the updated quantity before sending a price.`);
    }
  }
  const { priceFirmness, SIGNATURE_FIRMNESS } = await import("@/lib/precon/deal-move");
  const firmness = priceFirmness(worksheet, []);
  const openQuestions = workspace.decisions.filter(
    (decision) => decision.kind === "client_decision" && decision.status === "open",
  ).length;
  if (kind === "agreement" && (firmness.firmShare < SIGNATURE_FIRMNESS || openQuestions))
    throw new Error(
      openQuestions
        ? "Answer the open client questions before sending for signature."
        : "Firm up more of the price before sending for signature. Send a budget instead.",
    );
  const settings = estimateInputSchema.omit({ lines: true }).parse(input);
  const proposalLines = worksheetEstimateLines(worksheet);
  const { normalizeEstimateCommercial } =
    await import("@/lib/financials/estimate-commercial");
  const purpose = kind === "budget" ? ("budget" as const) : ("construction_agreement" as const);
  const measuredRows = worksheet.rows.filter((row) => row.metadata.takeoff).length;
  const quotedRows = worksheet.requests.filter((request) => request.quote).length;
  const commercial = {
    ...normalizeEstimateCommercial({}),
    ...settings.precon,
    purpose,
    maturity: kind === "agreement" ? ("construction_ready" as const) : ("conceptual" as const),
    pricing_basis:
      settings.precon?.pricing_basis ||
      [
        `Priced ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
        quotedRows ? `${quotedRows} trade quote${quotedRows === 1 ? "" : "s"}` : "",
        measuredRows ? `${measuredRows} quantit${measuredRows === 1 ? "y" : "ies"} measured from plans` : "",
        ...workspace.brief.governing_documents.map((file) => `Plans: ${file.name}`),
      ]
        .filter(Boolean)
        .join(" · "),
    payment_terms: settings.precon?.payment_terms || DEFAULT_PAYMENT_TERMS,
    allowance_policy: settings.precon?.allowance_policy || DEFAULT_ALLOWANCE_POLICY,
    brief_version: pricingBriefVersion(workspace.brief, workspace.version),
    governing_documents: workspace.brief.governing_documents,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(worksheet))
    .digest("hex");
  const proposalFingerprint = createHash("sha256")
    .update(JSON.stringify({ worksheet, settings, commercial, proposalLines }))
    .digest("hex");
  const draft = {
    ...settings,
    precon: commercial,
    prospect_id: prospectId,
    project_id: context.projectId ?? null,
    pricing_worksheet_snapshot: {
      version: workspace.version,
      fingerprint,
      proposal_fingerprint: proposalFingerprint,
      ...(kind === "budget"
        ? { range: { low_cents: firmness.range.low, high_cents: firmness.range.high } }
        : {}),
    },
    tax_rate: worksheet.tax_rate,
    markup_percent: worksheet.markup_percent,
    contingency_percent: worksheet.contingency_percent,
    lines: proposalLines.map((line, index) => ({
      ...line,
      markup_pct: line.markup_pct ?? 0,
      sort_order: index,
    })),
  };
  const prior = await context.supabase
    .from("estimates")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("prospect_id", prospectId)
    .eq("is_current_version", true)
    .contains("metadata", { precon: { purpose } })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prior.error)
    throw new Error("Unable to check the latest document version.");
  if (
    prior.data?.status === "draft" &&
    prior.data.metadata?.pricing_worksheet?.proposal_fingerprint ===
      proposalFingerprint
  )
    return prior.data as import("@/lib/types").Estimate;
  if (prior.data)
    return createEstimateVersion({ estimateId: prior.data.id, input: draft });
  const result = await createEstimate(draft);
  return result.estimate as import("@/lib/types").Estimate;
}

/** Only files stored in this workspace may be exposed through its bid portal. */
export async function getPricingRequestResources(prospectId: string) {
  const context = await authorizePreconWorkspaceWrite(prospectId);
  const [{ listContacts }, { listPreconDocuments }, { listDrawingSets }] =
    await Promise.all([
      import("./contacts"),
      import("./precon-workspace"),
      import("./drawings"),
    ]);
  const [contacts, files, sets] = await Promise.all([
    listContacts(context.orgId),
    listPreconDocuments(prospectId),
    context.projectId
      ? listDrawingSets({ project_id: context.projectId }, context.orgId)
      : Promise.resolve([]),
  ]);
  return {
    files: files.map((file) => {
      const drawing = sets.find((set) => set.source_file_id === file.id);
      return {
        ...file,
        source: drawing ? ("Drawings" as const) : ("Documents" as const),
        name: drawing ? `${drawing.title} · ${file.name}` : file.name,
      };
    }),
    contacts: contacts
      .filter((contact) => contact.email)
      .map((contact) => ({
        id: contact.id,
        name: contact.full_name,
        email: contact.email!,
        company_id: contact.primary_company_id ?? null,
        company_name: contact.primary_company?.name ?? null,
      })),
  };
}

export async function savePricingRequestDetails(
  prospectId: string,
  packageId: string,
  input: unknown,
) {
  const { pkg } = await pricingPackageContext(prospectId, packageId, true);
  if (["closed", "awarded", "cancelled"].includes(pkg.status))
    throw new Error("This request is closed to changes.");
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(200),
      due_at: z.string().datetime().nullable(),
      due_tz: z.string().min(1).max(100),
      instructions: z.string().max(12000),
      file_ids: z.array(z.string().uuid()).max(250),
      notify_bidders: z.boolean().default(false),
    })
    .parse(input);
  const { listPreconDocuments } = await import("./precon-workspace");
  const [{ attachFile, detachFileById, listAttachments }, files] =
    await Promise.all([
      import("./file-links"),
      listPreconDocuments(prospectId),
    ]);
  if (parsed.file_ids.some((id) => !files.some((file) => file.id === id)))
    throw new Error("Choose files from this workspace only.");
  const attached = await listAttachments("bid_package", packageId);
  const instructionsChanged = parsed.instructions !== (pkg.instructions ?? "");
  const issued = pkg.status !== "draft";
  if (issued && instructionsChanged && !parsed.notify_bidders)
    throw new Error(
      "Edit details and notify bidders to change issued instructions.",
    );
  if (issued && instructionsChanged)
    await beginBidScopeRevision({
      bidPackageId: packageId,
      reason: "Bid instructions updated from Pricing",
    });
  await updateBidPackage({
    bidPackageId: packageId,
    input: {
      title: parsed.title,
      due_at: parsed.due_at,
      due_tz: parsed.due_tz,
      ...(instructionsChanged ? { instructions: parsed.instructions } : {}),
      ...(issued && instructionsChanged ? { status: pkg.status } : {}),
    },
  });
  for (const fileId of new Set(parsed.file_ids)) {
    if (!attached.some((link) => link.file_id === fileId))
      await attachFile({
        file_id: fileId,
        entity_type: "bid_package",
        entity_id: packageId,
      });
  }
  for (const link of attached) {
    if (!parsed.file_ids.includes(link.file_id)) await detachFileById(link.id);
  }
  if (issued && parsed.notify_bidders) {
    const changes = [
      pkg.title !== parsed.title ? `Bid name: ${parsed.title}` : "",
      pkg.due_at !== parsed.due_at
        ? `Deadline: ${parsed.due_at ? `${parsed.due_at} (${parsed.due_tz})` : "No deadline"}`
        : "",
      instructionsChanged
        ? `Updated instructions:\n${parsed.instructions || "No instructions"}\nPlease review and submit a quote against the updated scope revision.`
        : "",
      `Shared documents: ${
        files
          .filter((file) => parsed.file_ids.includes(file.id))
          .map((file) => file.name)
          .join(", ") || "None"
      }`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const notice = await createBidAddendum({
      input: {
        bid_package_id: packageId,
        title: "Request details updated",
        message: changes,
      },
    });
    return notice.notifications;
  }
  return null;
}

export async function retryPricingNotice(prospectId: string, packageId: string, addendumId: string) {
  await pricingPackageContext(prospectId, packageId, true);
  const { listBidAddenda, retryBidAddendumNotifications } = await import("./bids");
  if (!(await listBidAddenda(packageId)).some(notice => notice.id === addendumId)) throw new Error("This notice does not belong to the request.");
  return retryBidAddendumNotifications({ addendumId });
}

export async function revisePricingRequestScope(prospectId: string, packageId: string, expectedVersion: number, reason: string) {
  const { workspace } = await pricingPackageContext(prospectId, packageId, true);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  const { requireAuthorization } = await import("./authorization");
  await requireAuthorization({ ...context, permission: "project.manage", projectId: context.projectId });
  const parsedReason = z.string().trim().min(1).max(4000).parse(reason);
  if (!workspace.pricing || workspace.version !== expectedVersion) throw new Error("Save the latest worksheet before revising scope.");
  const request = workspace.pricing.requests.find(item => item.package_id === packageId);
  if (!request) throw new Error("Link the request before revising scope.");
  const signature = scopeSignature(workspace.pricing.rows.filter(row => request.row_ids.includes(row.id)));
  const result = await context.service.rpc("revise_precon_pricing_scope", {
    p_org_id: context.orgId, p_prospect_id: prospectId, p_package_id: packageId, p_user_id: context.userId,
    p_expected_version: expectedVersion, p_signature: signature, p_reason: parsedReason,
  });
  if (result.error) throw new Error(result.error.message);
  const saved = result.data as { worksheet: PricingWorksheet; version: number; addendumId: string };
  const { retryBidAddendumNotifications } = await import("./bids");
  const notifications = await retryBidAddendumNotifications({ addendumId: saved.addendumId }).catch(() => ({
    addendumId: saved.addendumId, queued: [] as string[], alreadyQueued: [] as string[],
    failed: [{ recipient: "Bidders", error: "Scope was revised, but notifications could not be queued. Retry delivery." }],
  }));
  return { ...saved, notifications };
}
