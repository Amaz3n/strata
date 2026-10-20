"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action-result";
import {
  clockIn,
  clockOut,
  endBreak,
  getClockCostCodes,
  startBreak,
  switchClock,
} from "@/lib/services/time-clock";
import {
  approveTimeEntries,
  closePayPeriod,
  correctLockedTimeEntry,
  exportPayPeriod,
  rejectTimeEntries,
} from "@/lib/services/timesheets";

function revalidateTime() {
  revalidatePath("/trade/crew");
  revalidatePath("/projects/[id]/time", "page");
}

export async function clockInAction(input: unknown) {
  return runAction(async () => {
    const parsed = typeof input === "object" && input !== null ? input : {};
    const result = await clockIn({ ...parsed, source: "web" });
    revalidateTime();
    return result;
  });
}

export async function switchClockAction(input: unknown) {
  return runAction(async () => {
    const result = await switchClock(input);
    revalidateTime();
    return result;
  });
}

export async function startBreakAction() {
  return runAction(async () => {
    const result = await startBreak({});
    revalidateTime();
    return result;
  });
}

export async function endBreakAction() {
  return runAction(async () => {
    const result = await endBreak({});
    revalidateTime();
    return result;
  });
}

export async function clockOutAction() {
  return runAction(async () => {
    const result = await clockOut({});
    revalidateTime();
    return result;
  });
}

export async function getClockCostCodesAction(projectId: string) {
  return runAction(() => getClockCostCodes(projectId));
}

export async function approveTimeEntriesAction(input: unknown) {
  return runAction(async () => {
    const result = await approveTimeEntries(input);
    revalidateTime();
    return result;
  });
}

export async function rejectTimeEntriesAction(input: unknown) {
  return runAction(async () => {
    const result = await rejectTimeEntries(input);
    revalidateTime();
    return result;
  });
}

export async function closePayPeriodAction(input: unknown) {
  return runAction(async () => {
    const result = await closePayPeriod(input);
    revalidateTime();
    return result;
  });
}

export async function exportPayPeriodAction(input: unknown) {
  return runAction(() => exportPayPeriod(input));
}

export async function correctLockedTimeEntryAction(input: unknown) {
  return runAction(async () => {
    const result = await correctLockedTimeEntry(input);
    revalidateTime();
    return result;
  });
}
