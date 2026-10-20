"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action-result";
import {
  closeTradeOpportunity,
  getQuoteLinesForReuse,
  listReusableQuotes,
  logOpportunityContact,
  recordQuoteAcceptance,
  reopenTradeOpportunity,
  reviseTradeQuote,
  saveTradeQuote,
  sendTradeQuote,
  setOpportunityDue,
  setOpportunityFollowUp,
  startTradeJobFromQuote,
  updateOpportunityCustomer,
} from "@/lib/services/trade-quotes";

/** A trade opportunity's mutations. The desk and Today read the same rows, so both refresh. */
function revalidateOpportunity() {
  revalidatePath("/pipeline/[dealId]", "layout");
  revalidatePath("/pipeline");
  revalidatePath("/");
}

export async function saveTradeQuoteAction(input: unknown) {
  return runAction(async () => {
    const result = await saveTradeQuote(input);
    revalidateOpportunity();
    return result;
  });
}

export async function reviseTradeQuoteAction(input: unknown) {
  return runAction(async () => {
    const result = await reviseTradeQuote(input);
    revalidateOpportunity();
    return result;
  });
}

export async function sendTradeQuoteAction(input: unknown) {
  return runAction(async () => {
    const result = await sendTradeQuote(input);
    revalidateOpportunity();
    return result;
  });
}

export async function recordQuoteAcceptanceAction(input: unknown) {
  return runAction(async () => {
    const result = await recordQuoteAcceptance(input);
    revalidateOpportunity();
    return result;
  });
}

export async function closeTradeOpportunityAction(input: unknown) {
  return runAction(async () => {
    const result = await closeTradeOpportunity(input);
    revalidateOpportunity();
    return result;
  });
}

export async function reopenTradeOpportunityAction(input: unknown) {
  return runAction(async () => {
    const result = await reopenTradeOpportunity(input);
    revalidateOpportunity();
    return result;
  });
}

export async function setOpportunityDueAction(input: unknown) {
  return runAction(async () => {
    const result = await setOpportunityDue(input);
    revalidateOpportunity();
    return result;
  });
}

export async function setOpportunityFollowUpAction(input: unknown) {
  return runAction(async () => {
    const result = await setOpportunityFollowUp(input);
    revalidateOpportunity();
    return result;
  });
}

export async function logOpportunityContactAction(prospectId: unknown, input: unknown) {
  return runAction(async () => {
    const result = await logOpportunityContact(prospectId, input);
    revalidateOpportunity();
    return result;
  });
}

export async function startTradeJobFromQuoteAction(input: unknown) {
  return runAction(async () => {
    const result = await startTradeJobFromQuote(input);
    revalidateOpportunity();
    revalidatePath("/projects");
    return result;
  });
}

export async function listReusableQuotesAction() {
  return runAction(() => listReusableQuotes());
}

export async function getQuoteLinesForReuseAction(input: unknown) {
  return runAction(() => getQuoteLinesForReuse(input));
}

export async function updateOpportunityCustomerAction(input: unknown) {
  return runAction(async () => {
    const result = await updateOpportunityCustomer(input);
    revalidateOpportunity();
    return result;
  });
}
