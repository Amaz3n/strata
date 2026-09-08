"use server"
import { revalidatePath } from "next/cache"
import { actionError } from "@/lib/action-result"
import {
  loadPayableWaivers,
  preparePayableWaiver,
  reviewPayableWaiver,
} from "@/lib/services/payable-waivers"
export async function loadPayableWaiversAction(billId: string) {
  try {
    return { success: true as const, data: await loadPayableWaivers(billId) }
  } catch (error) {
    return actionError(error, "Could not load waivers")
  }
}
export async function preparePayableWaiverAction(form: FormData) {
  try {
    const file = form.get("file")
    const result = await preparePayableWaiver(
      JSON.parse(String(form.get("input"))),
      file instanceof File ? file : undefined,
    )
    revalidatePath("/payables")
    revalidatePath("/projects", "layout")
    return { success: true as const, data: result }
  } catch (error) {
    return actionError(error, "Could not prepare waiver")
  }
}
export async function reviewPayableWaiverAction(
  billId: string,
  waiverId: string,
  status: "accepted" | "rejected",
  note: string,
) {
  try {
    if (status !== "accepted" && status !== "rejected")
      throw new Error("Choose a review decision")
    const result = await reviewPayableWaiver(billId, waiverId, status, note)
    revalidatePath("/payables")
    revalidatePath("/projects", "layout")
    return { success: true as const, data: result }
  } catch (error) {
    return actionError(error, "Could not review waiver")
  }
}
export async function manageSubtierWaiverAction(form: FormData) {
  try {
    const { manageSubtierWaiver } =
      await import("@/lib/services/payable-waivers")
    const file = form.get("file")
    await manageSubtierWaiver(
      JSON.parse(String(form.get("input"))),
      file instanceof File ? file : undefined,
    )
    revalidatePath("/projects", "layout")
    return { success: true as const, data: null }
  } catch (error) {
    return actionError(error, "Could not update claimant waiver")
  }
}
export async function carryForwardClaimantsAction(
  projectId: string,
  periodEnd: string,
) {
  try {
    const { carryForwardClaimants } =
      await import("@/lib/services/payable-waivers")
    const count = await carryForwardClaimants(projectId, periodEnd)
    revalidatePath("/projects", "layout")
    return { success: true as const, data: count }
  } catch (error) {
    return actionError(error, "Could not carry forward claimants")
  }
}
export async function setPayableWorkThroughAction(
  billId: string,
  date: string,
) {
  try {
    const { setPayableWorkThrough } =
      await import("@/lib/services/payable-waivers")
    await setPayableWorkThrough(billId, date)
    revalidatePath("/projects", "layout")
    revalidatePath("/payables")
    return { success: true as const, data: null }
  } catch (error) {
    return actionError(error, "Could not save work through date")
  }
}
export async function suggestPayableWaiverDetailsAction(
  billId: string,
  form: FormData,
) {
  try {
    const { suggestPayableWaiverDetails } =
      await import("@/lib/services/payable-waivers")
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("Choose a signed PDF")
    return {
      success: true as const,
      data: await suggestPayableWaiverDetails(billId, file),
    }
  } catch (error) {
    return actionError(error, "Could not read PDF")
  }
}
