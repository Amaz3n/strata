"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError, type ActionResult } from "@/lib/action-result";
import {
  dealAnswerInputSchema,
  dealClientInputSchema,
  dealLostInputSchema,
  dealNotesInputSchema,
  dealQuestionInputSchema,
  newDealInputSchema,
} from "@/lib/validation/deals";

const idSchema = z.string().uuid();

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await work();
    // The list and the open deal share one layout; both reflect every change.
    revalidatePath("/pipeline", "layout");
    return { success: true, data };
  } catch (error) {
    return actionError(error);
  }
}

async function openDeal(prospectId: string) {
  const { authorizePreconWorkspaceWrite } = await import("@/lib/services/precon-workspace");
  const context = await authorizePreconWorkspaceWrite(idSchema.parse(prospectId));
  if (context.prospectStatus === "lost") throw new Error("Reopen the deal before changing it.");
  if (context.prospectStatus === "won" || context.projectPhase === "delivery")
    throw new Error("This deal is now a job. Make changes in the project.");
  return context;
}

export async function createDealAction(input: unknown) {
  return run(async () => {
    const { name } = newDealInputSchema.parse(input);
    const { createProspect } = await import("@/lib/services/prospects");
    const prospect = await createProspect({ input: { name, status: "new" } });
    return { id: prospect.id };
  });
}

export async function saveDealNotesAction(prospectId: string, notes: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { updateProspect } = await import("@/lib/services/prospects");
    await updateProspect({ prospectId, input: { notes: dealNotesInputSchema.parse(notes) } });
  });
}

/** Each line of the notes becomes a line to price, on the deal's pricing workspace. */
export async function startDealPricingAction(prospectId: string, notes: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const text = dealNotesInputSchema.parse(notes);
    const descriptions = text
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-•*\d.)]+\s*/, "").trim())
      .filter(Boolean)
      .map((line) => line.charAt(0).toUpperCase() + line.slice(1))
      .slice(0, 200);
    if (!descriptions.length) throw new Error("Write at least one line about the job first.");
    const [{ updateProspect }, { startProspectPricing }, { getPreconWorkspace }, { savePricingWorksheet }, { pricingRowSchema, EMPTY_PRICING_WORKSHEET }] =
      await Promise.all([
        import("@/lib/services/prospects"),
        import("@/lib/services/conversions"),
        import("@/lib/services/precon-workspace"),
        import("@/lib/services/precon-pricing"),
        import("@/lib/precon/pricing-worksheet"),
      ]);
    await updateProspect({ prospectId, input: { notes: text } });
    await startProspectPricing({ prospectId });
    const workspace = await getPreconWorkspace(prospectId);
    const current = workspace.pricing ?? EMPTY_PRICING_WORKSHEET;
    if (current.rows.length) return { lines: current.rows.length };
    await savePricingWorksheet(
      prospectId,
      {
        ...current,
        rows: descriptions.map((description) =>
          pricingRowSchema.parse({ id: crypto.randomUUID(), description: description.slice(0, 1000) }),
        ),
      },
      workspace.version,
    );
    return { lines: descriptions.length };
  });
}

export async function updateDealClientAction(prospectId: string, input: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const parsed = dealClientInputSchema.parse(input);
    const { getProspect, updateProspect, createProspectContact, updateProspectContact } =
      await import("@/lib/services/prospects");
    const prospect = await getProspect(prospectId);
    if (!prospect) throw new Error("Deal not found.");
    await updateProspect({
      prospectId,
      input: {
        name: parsed.name,
        jobsite_location: {
          street: parsed.street,
          city: parsed.city,
          state: parsed.state,
          postal_code: parsed.postal_code,
        },
      },
    });
    const contact = {
      full_name: parsed.client_name,
      email: parsed.email || null,
      phone: parsed.phone || null,
      is_primary: true,
    };
    if (prospect.primary_contact)
      await updateProspectContact({ contactId: prospect.primary_contact.id, input: contact });
    else await createProspectContact({ prospectId, input: contact });
  });
}

/** Sends whichever document the price has earned: a budget while it is soft, the agreement once it is firm. */
export async function sendDealPriceAction(
  prospectId: string,
  kind: "budget" | "agreement",
  worksheetVersion: number,
) {
  return run(async () => {
    await openDeal(prospectId);
    const document = z.enum(["budget", "agreement"]).parse(kind);
    const [{ getProspect }, { prepareDealDocument }, { sendEstimate }] = await Promise.all([
      import("@/lib/services/prospects"),
      import("@/lib/services/precon-pricing"),
      import("@/lib/services/estimate-portal"),
    ]);
    const prospect = await getProspect(prospectId);
    const recipient = prospect?.primary_contact;
    if (!recipient?.email)
      throw new Error("Add the client's email address before sending. Use Client details.");
    const prepared = await prepareDealDocument(
      prospectId,
      document,
      {
        title: `${prospect.name} — ${document === "budget" ? "Budget" : "Proposal & agreement"}`,
        recipient_name: recipient.full_name,
        recipient_email: recipient.email,
        summary: prospect.notes ?? undefined,
      },
      z.number().int().nonnegative().parse(worksheetVersion),
    );
    const sent = await sendEstimate({ estimateId: prepared.id });
    return { emailSent: sent.emailSent, documentId: prepared.id };
  });
}

export async function remindDealClientAction(prospectId: string, documentId: string) {
  return run(async () => {
    await openDeal(prospectId);
    const { sendEstimate } = await import("@/lib/services/estimate-portal");
    const { createServiceSupabaseClient } = await import("@/lib/supabase/server");
    const { requireOrgContext } = await import("@/lib/services/context");
    const { orgId } = await requireOrgContext();
    const owned = await createServiceSupabaseClient()
      .from("estimates")
      .select("id")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .eq("id", idSchema.parse(documentId))
      .maybeSingle();
    if (owned.error || !owned.data) throw new Error("This document does not belong to the deal.");
    const sent = await sendEstimate({
      estimateId: documentId,
      message: "A quick reminder: your document is ready for review.",
    });
    return { emailSent: sent.emailSent };
  });
}

export async function countersignDealAction(prospectId: string, documentId: string) {
  return run(async () => {
    await openDeal(prospectId);
    const { getEstimateBuilderSigningLink } = await import("@/lib/services/estimate-portal");
    return getEstimateBuilderSigningLink({ estimateId: idSchema.parse(documentId) });
  });
}

export async function askClientQuestionAction(prospectId: string, question: unknown) {
  return run(async () => {
    const context = await openDeal(prospectId);
    const { savePreconDecision } = await import("@/lib/services/precon-workspace");
    // Blocking the agreement is what makes an open question hold the price at budget.
    return savePreconDecision(prospectId, {
      title: dealQuestionInputSchema.parse(question),
      kind: "client_decision",
      detail: "",
      owner_user_id: context.userId,
      due_date: null,
      cost_impact_cents: null,
      blocks_agreement: true,
      blocks_start: false,
      status: "open",
      resolution: "",
    });
  });
}

export async function answerClientQuestionAction(prospectId: string, input: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const parsed = dealAnswerInputSchema.parse(input);
    const { getPreconWorkspace, savePreconDecision } = await import("@/lib/services/precon-workspace");
    const decision = (await getPreconWorkspace(prospectId)).decisions.find((item) => item.id === parsed.id);
    if (!decision || decision.kind !== "client_decision") throw new Error("Question not found.");
    return savePreconDecision(
      prospectId,
      { ...decision, status: "resolved", resolution: parsed.answer },
      parsed.id,
      parsed.version,
    );
  });
}

export async function markDealLostAction(prospectId: string, reason: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { updateProspect } = await import("@/lib/services/prospects");
    await updateProspect({
      prospectId,
      input: { status: "lost", lost_reason: dealLostInputSchema.parse(reason), next_follow_up_at: null },
    });
  });
}

export async function reopenDealAction(prospectId: string) {
  return run(async () => {
    const { getProspect, reopenProspect } = await import("@/lib/services/prospects");
    const { authorizePreconWorkspaceWrite } = await import("@/lib/services/precon-workspace");
    await authorizePreconWorkspaceWrite(idSchema.parse(prospectId));
    const prospect = await getProspect(prospectId);
    if (prospect?.status !== "lost") throw new Error("Only lost deals can be reopened.");
    await reopenProspect({ prospectId });
  });
}

export async function logDealActivityAction(prospectId: string, input: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { logProspectContactInputSchema } = await import("@/lib/validation/prospects");
    const { logProspectContact } = await import("@/lib/services/prospects");
    const parsed = logProspectContactInputSchema.parse(input);
    if (parsed.kind === "note" && !parsed.note?.trim()) throw new Error("Write a note before saving.");
    await logProspectContact({ prospectId, input: parsed });
  });
}

export async function getStartBuildingReviewAction(prospectId: string) {
  try {
    const { getProspectConversionReview } = await import("@/lib/services/precon-project-start");
    return { success: true as const, data: await getProspectConversionReview(idSchema.parse(prospectId)) };
  } catch (error) {
    return actionError(error);
  }
}

export async function startBuildingAction(prospectId: string, agreementId: string) {
  return run(async () => {
    const { startBuilding } = await import("@/lib/services/precon-project-start");
    const result = await startBuilding(idSchema.parse(prospectId), idSchema.parse(agreementId));
    revalidatePath(`/projects/${result.projectId}`, "layout");
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return result;
  });
}

export async function loadDealActivityAction(prospectId: string) {
  try {
    const { authorizePreconWorkspaceRead } = await import("@/lib/services/precon-workspace");
    await authorizePreconWorkspaceRead(idSchema.parse(prospectId));
    const { listProspectActivity } = await import("@/lib/services/prospects");
    return { success: true as const, data: await listProspectActivity(prospectId, undefined, 100) };
  } catch (error) {
    return actionError(error);
  }
}
