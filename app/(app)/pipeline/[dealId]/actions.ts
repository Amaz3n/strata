"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError, type ActionResult } from "@/lib/action-result";
import type { SearchPickerPage } from "@/components/ui/search-picker";
import {
  dealAnswerInputSchema,
  dealClientInputSchema,
  dealLostInputSchema,
  dealFollowUpInputSchema,
  dealFollowUpOutcomeSchema,
  dealLogInputSchema,
  dealNotesInputSchema,
  dealOwnerInputSchema,
  dealPriceSourceSearchSchema,
  dealPriceStartSchema,
  dealQuestionInputSchema,
  newDealInputSchema,
} from "@/lib/validation/deals";
import { proposalSignerSchema } from "@/lib/precon/proposal-documents";

const idSchema = z.string().uuid();

/** A follow-up is a day; it lands at nine that morning so it is due once the day starts. */
const followUpAt = (day: string) => new Date(`${day}T09:00:00`).toISOString();

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
    const deal = newDealInputSchema.parse(input);
    const [{ createProspect }, { compactMoney }] = await Promise.all([
      import("@/lib/services/prospects"),
      import("@/lib/precon/format"),
    ]);
    const client = deal.client;
    const prospect = await createProspect({
      input: {
        name: deal.name,
        status: "new",
        owner_user_id: deal.owner_user_id,
        source: deal.source === "Other" && deal.source_detail ? deal.source_detail : deal.source,
        budget_range: !deal.budget ? null : deal.budget.kind === "band" ? deal.budget.band : compactMoney(deal.budget.cents),
        timeline_preference: !deal.timeframe
          ? null
          : deal.timeframe.kind === "band"
            ? deal.timeframe.band
            : `Start by ${new Date(`${deal.timeframe.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
        notes: deal.notes || null,
        jobsite_location:
          deal.street || deal.city || deal.state || deal.postal_code
            ? { street: deal.street, city: deal.city, state: deal.state, postal_code: deal.postal_code }
            : null,
        // A new client is promoted into the directory with the deal, so cancelling leaves nothing behind.
        primary_contact: !client
          ? undefined
          : client.kind === "existing"
            ? { full_name: client.name, contact_id: client.contact_id, is_primary: true }
            : {
                full_name: client.full_name,
                email: client.email || null,
                phone: client.phone || null,
                company_name: client.company_name || null,
                is_primary: true,
              },
      },
    });
    return { id: prospect.id };
  });
}

/** People already in the directory, a page per search, for the new deal's client picker. Read-only. */
export async function searchDealClientsAction(input: unknown): Promise<ActionResult<SearchPickerPage>> {
  // Not `run()`: a lookup changes nothing, so it must not revalidate the pipeline on every keystroke.
  try {
    const [{ searchDirectoryPeople }, { searchPickerQuerySchema, searchPickerPage, SEARCH_PICKER_PAGE_SIZE }] =
      await Promise.all([import("@/lib/services/sales-inquiries"), import("@/lib/search-picker")]);
    const query = searchPickerQuerySchema.parse(input);
    const result = await searchDirectoryPeople({ search: query.search, page: query.page, pageSize: SEARCH_PICKER_PAGE_SIZE });
    const data = searchPickerPage(
      result.people.map((person) => ({
        id: person.id,
        name: person.name,
        detail: [person.email, person.phone, person.roles.join(", ")].filter(Boolean).join(" · "),
      })),
      result.page,
      result.pageSize,
      result.total,
    );
    return { success: true, data };
  } catch (error) {
    return actionError(error);
  }
}

export async function saveDealNotesAction(prospectId: string, notes: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { updateProspect } = await import("@/lib/services/prospects");
    await updateProspect({ prospectId, input: { notes: dealNotesInputSchema.parse(notes) } });
  });
}

/** Starts the price from a template, a past deal, the plans or a blank sheet. */
export async function startDealPriceAction(prospectId: string, start: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { startDealPrice } = await import("@/lib/services/precon-deals");
    return startDealPrice(prospectId, dealPriceStartSchema.parse(start));
  });
}

/** Past deals with lines to copy. Read-only, so it never revalidates the deal. */
export async function searchDealPriceSourcesAction(prospectId: string, search: unknown) {
  try {
    const { listDealPriceSources } = await import("@/lib/services/precon-deals");
    return {
      success: true as const,
      data: await listDealPriceSources(idSchema.parse(prospectId), dealPriceSourceSearchSchema.parse(search)),
    };
  } catch (error) {
    return actionError(error);
  }
}

/** Schedules the deal's next follow-up, replacing an open one. */
export async function scheduleDealFollowUpAction(prospectId: string, input: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { setProspectFollowUp } = await import("@/lib/services/prospects");
    const parsed = dealFollowUpInputSchema.parse(input);
    await setProspectFollowUp({ prospectId, nextFollowUpAt: followUpAt(parsed.on), note: parsed.note || null });
  });
}

/** Closes the open follow-up: done, or no longer needed. */
export async function closeDealFollowUpAction(prospectId: string, outcome: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { setProspectFollowUp } = await import("@/lib/services/prospects");
    await setProspectFollowUp({ prospectId, nextFollowUpAt: null, outcome: dealFollowUpOutcomeSchema.parse(outcome) });
  });
}

export async function assignDealOwnerAction(prospectId: string, ownerUserId: unknown) {
  return run(async () => {
    await openDeal(prospectId);
    const { updateProspect } = await import("@/lib/services/prospects");
    await updateProspect({ prospectId, input: { owner_user_id: dealOwnerInputSchema.parse(ownerUserId) } });
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

/**
 * Sends the proposal: for signature at a fixed price, or for approval as a
 * range. The first signer is the deal's client, so a name or email corrected in
 * Review & send is saved to the client before anything goes out.
 */
export async function sendDealPriceAction(
  prospectId: string,
  kind: "budget" | "agreement",
  worksheetVersion: number,
  proposalVersion: number,
  message: string,
  client: unknown,
) {
  return run(async () => {
    await openDeal(prospectId);
    const document = z.enum(["budget", "agreement"]).parse(kind);
    const recipient = proposalSignerSchema.parse(client);
    const [{ getProspect, updateProspectContact, createProspectContact }, { prepareDealDocument }, { sendEstimate }] =
      await Promise.all([
        import("@/lib/services/prospects"),
        import("@/lib/services/precon-pricing"),
        import("@/lib/services/estimate-portal"),
      ]);
    const prospect = await getProspect(prospectId);
    if (!prospect) throw new Error("Deal not found.");
    const contact = prospect.primary_contact;
    if (!contact) await createProspectContact({ prospectId, input: { full_name: recipient.name, email: recipient.email, is_primary: true } });
    else if (contact.full_name !== recipient.name || contact.email !== recipient.email)
      await updateProspectContact({ contactId: contact.id, input: { full_name: recipient.name, email: recipient.email } });
    const version = z.number().int().nonnegative();
    const prepared = await prepareDealDocument(
      prospectId,
      document,
      {
        title: `${prospect.name} — Proposal`,
        recipient_name: recipient.name,
        recipient_email: recipient.email,
      },
      version.parse(worksheetVersion),
      version.parse(proposalVersion),
    );
    const sent = await sendEstimate({
      estimateId: prepared.id,
      message: z.string().trim().max(4000).parse(message) || undefined,
    });
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
    const parsed = dealLogInputSchema.parse(input);
    if (parsed.kind === "note" && !parsed.note) throw new Error("Write a note before saving.");
    const { logProspectContact, setProspectFollowUp } = await import("@/lib/services/prospects");
    // The browser sends a day only when it was not today; it lands at noon so it sorts inside that day.
    const occurredAt = parsed.occurred_on ? new Date(`${parsed.occurred_on}T12:00:00`).toISOString() : null;
    await logProspectContact({ prospectId, input: { kind: parsed.kind, note: parsed.note || null, occurredAt } });
    if (parsed.complete_follow_up) await setProspectFollowUp({ prospectId, nextFollowUpAt: null, outcome: "done" });
    if (parsed.follow_up)
      await setProspectFollowUp({
        prospectId,
        nextFollowUpAt: followUpAt(parsed.follow_up.on),
        note: parsed.follow_up.note || null,
      });
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
