"use server";

import { revalidatePath } from "next/cache";
import { actionError, type ActionResult } from "@/lib/action-result";
import {
  getPricingRequestResources,
  resendPricingInvitation,
  savePricingRequestDetails,
  savePricingWorksheet,
  createPricingRequest,
  getPricingQuotes,
  selectPricingQuote,
  sendPricingRequest,
  recordPricingQuote,
} from "@/lib/services/precon-pricing";

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await work();
    revalidatePath("/pipeline", "layout");
    return { success: true, data };
  } catch (error) {
    return actionError(error);
  }
}
export async function savePricingWorksheetAction(
  id: string,
  input: unknown,
  version: number,
) {
  return run(() => savePricingWorksheet(id, input, version));
}
export async function createPricingRequestAction(
  id: string,
  input: unknown,
  version: number,
) {
  return run(() => createPricingRequest(id, input, version));
}
export async function getPricingQuotesAction(id: string, packageId: string) {
  try {
    return {
      success: true as const,
      data: await getPricingQuotes(id, packageId),
    };
  } catch (error) {
    return actionError(error);
  }
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

export async function getPricingRequestResourcesAction(id: string) {
  try {
    return {
      success: true as const,
      data: await getPricingRequestResources(id),
    };
  } catch (error) {
    return actionError(error);
  }
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

export async function retryPricingNoticeAction(id: string, packageId: string, addendumId: string) {
  return run(async () => (await import("@/lib/services/precon-pricing")).retryPricingNotice(id, packageId, addendumId));
}

export async function revisePricingRequestScopeAction(id: string, packageId: string, version: number, reason: string) {
  return run(async () => (await import("@/lib/services/precon-pricing")).revisePricingRequestScope(id, packageId, version, reason));
}
