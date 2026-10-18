"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action-result";
import { saveBusinessProfile } from "@/lib/services/business-profile";
import {
  createTradeJob,
  scheduleTradeWork,
} from "@/lib/services/trade-workspace";

export async function saveTradeProfileAction(input: unknown) {
  return runAction(async () => {
    const result = await saveBusinessProfile(input);
    revalidatePath("/", "layout");
    return result;
  });
}

export async function createTradeJobAction(input: unknown) {
  return runAction(async () => {
    const result = await createTradeJob(input);
    revalidatePath("/", "layout");
    return result;
  });
}

export async function scheduleTradeWorkAction(input: unknown) {
  return runAction(async () => {
    const result = await scheduleTradeWork(input);
    revalidatePath("/trade/crew");
    revalidatePath("/");
    revalidatePath(`/projects/${result.project_id}/schedule`);
    return result;
  });
}
