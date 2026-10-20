"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action-result";
import { createTradeOpportunity, trackBuilderInvitation } from "@/lib/services/trade-quotes";

export async function createTradeOpportunityAction(input: unknown) {
  return runAction(async () => {
    const result = await createTradeOpportunity(input);
    revalidatePath("/pipeline");
    revalidatePath("/");
    return result;
  });
}

export async function trackBuilderInvitationAction(grantId: unknown) {
  return runAction(async () => {
    const result = await trackBuilderInvitation(grantId);
    revalidatePath("/pipeline");
    revalidatePath("/trade/connections");
    return result;
  });
}
