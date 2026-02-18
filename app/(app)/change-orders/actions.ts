"use server"

import { revalidatePath } from "next/cache"

import { approveChangeOrder, createChangeOrder, listChangeOrders, publishChangeOrder } from "@/lib/services/change-orders"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function listChangeOrdersAction(projectId?: string) {
  try {
    return await listChangeOrders({ projectId })
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createChangeOrderAction(input: unknown) {
  try {
    const parsed = changeOrderInputSchema.parse(input)
    const changeOrder = await createChangeOrder({ input: parsed })
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function publishChangeOrderAction(changeOrderId: string) {
  try {
    const changeOrder = await publishChangeOrder(changeOrderId)
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function approveChangeOrderAction(changeOrderId: string) {
  try {
    const changeOrder = await approveChangeOrder({ changeOrderId })
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
