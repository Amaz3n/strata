"use server";

import { revalidatePath } from "next/cache";
import { actionError, type ActionResult } from "@/lib/action-result";
import {
  resendPricingInvitation,
  savePricingRequestDetails,
  savePricingWorksheet,
  selectPricingQuote,
  sendPricingRequest,
  recordPricingQuote,
} from "@/lib/services/precon-pricing";

async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return actionError(error);
  }
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  const result = await attempt(work);
  if (result.success) revalidatePath("/pipeline", "layout");
  return result;
}
// Autosave: the room holds the live worksheet, so re-running the deal's
// loaders (and dropping every tab's cached data) on each save only slows it.
export async function savePricingWorksheetAction(
  id: string,
  input: unknown,
  version: number,
) {
  return attempt(() => savePricingWorksheet(id, input, version));
}
export async function selectPricingQuoteAction(
  id: string,
  packageId: string,
  input: unknown,
  version: number,
) {
  return run(() => selectPricingQuote(id, packageId, input, version));
}
export async function sendPricingRequestAction(
  id: string,
  packageId: string,
  input: unknown,
) {
  return run(() => sendPricingRequest(id, packageId, input));
}
export async function recordPricingQuoteAction(
  id: string,
  packageId: string,
  input: unknown,
) {
  return run(() => recordPricingQuote(id, packageId, input));
}

export async function resendPricingInvitationAction(
  id: string,
  packageId: string,
  inviteId: string,
) {
  return run(() => resendPricingInvitation(id, packageId, inviteId));
}
export async function savePricingRequestDetailsAction(
  id: string,
  packageId: string,
  input: unknown,
) {
  return run(() => savePricingRequestDetails(id, packageId, input));
}

export async function getLatestPricingWorksheetAction(id: string) {
  return run(async () => {
    const { getPreconWorkspace } = await import("@/lib/services/precon-workspace");
    const workspace = await getPreconWorkspace(id);
    return { worksheet: workspace.pricing ?? null, version: workspace.version };
  });
}

export async function revisePricingRequestScopeAction(id: string, packageId: string, version: number, reason: string) {
  return run(async () => (await import("@/lib/services/precon-pricing")).revisePricingRequestScope(id, packageId, version, reason));
}

export async function issuePricingRequestAction(id: string, input: unknown, version: number) {
  return run(async () => (await import("@/lib/services/precon-pricing")).issuePricingRequest(id, input, version));
}

export async function setPricingBidPlugAction(id: string, packageId: string, itemId: string, plugCents: number | null) {
  return run(async () => (await import("@/lib/services/precon-pricing")).setPricingBidPlug(id, packageId, itemId, plugCents));
}

export async function answerPricingQuestionAction(id: string, packageId: string, rfiId: string, body: string) {
  return run(async () => (await import("@/lib/services/precon-pricing")).answerPricingQuestion(id, packageId, rfiId, body));
}
