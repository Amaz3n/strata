"use server"

import { revalidatePath } from "next/cache"

import { attestPaymentLaunchGate, type PaymentLaunchGateKey } from "@/lib/services/payment-launch-readiness"

export async function attestPaymentLaunchGateAction(formData: FormData) {
  await attestPaymentLaunchGate({
    gateKey: String(formData.get("gate_key") ?? "") as PaymentLaunchGateKey,
    decision: String(formData.get("decision") ?? "") as "approved" | "revoked",
    evidenceReference: String(formData.get("evidence_reference") ?? ""),
    note: String(formData.get("note") ?? ""),
  })
  revalidatePath("/admin/ops/payment-launch")
}
