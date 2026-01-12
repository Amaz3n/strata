"use server"

import { revalidatePath } from "next/cache"

import { approveChangeOrder, createChangeOrder, listChangeOrders, publishChangeOrder } from "@/lib/services/change-orders"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"

export async function listChangeOrdersAction(projectId?: string) {
  return listChangeOrders({ projectId })
}

export async function createChangeOrderAction(input: unknown) {
  const parsed = changeOrderInputSchema.parse(input)
  const changeOrder = await createChangeOrder({ input: parsed })
  revalidatePath("/change-orders")
  return changeOrder
}

export async function publishChangeOrderAction(changeOrderId: string) {
  const changeOrder = await publishChangeOrder(changeOrderId)
  revalidatePath("/change-orders")
  return changeOrder
}

export async function approveChangeOrderAction(changeOrderId: string) {
  const changeOrder = await approveChangeOrder({ changeOrderId })
  revalidatePath("/change-orders")
  return changeOrder
}





