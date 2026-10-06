"use server";
import { runAction } from "@/lib/action-result";
import { openTradeBuilderConnection } from "@/lib/services/external-portal-auth";
export async function openBuilderConnectionAction(grantId: string) {
  return runAction(() => openTradeBuilderConnection(grantId));
}
