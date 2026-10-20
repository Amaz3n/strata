"use server";

import { revalidatePath } from "next/cache";
import { runAction } from "@/lib/action-result";
import { saveBusinessProfile } from "@/lib/services/business-profile";
import {
  shareOwnComplianceDocument,
  uploadOwnComplianceDocument,
} from "@/lib/services/own-compliance";
import { saveTimePolicy } from "@/lib/services/time-policy";
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

export async function saveTimePolicyAction(input: unknown) {
  return runAction(async () => {
    const result = await saveTimePolicy(input);
    revalidatePath("/trade/setup");
    revalidatePath("/trade/crew");
    return result;
  });
}

export async function uploadOwnComplianceDocumentAction(formData: FormData) {
  return runAction(async () => {
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("Choose a file to upload");
    const text = (name: string) => {
      const value = formData.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const coverage = text("coverage_dollars");
    const result = await uploadOwnComplianceDocument(
      {
        document_type_code: text("document_type_code"),
        effective_date: text("effective_date"),
        expiry_date: text("expiry_date"),
        carrier_name: text("carrier_name"),
        policy_number: text("policy_number"),
        coverage_amount_cents: coverage ? Math.round(Number(coverage) * 100) : undefined,
        license_number: text("license_number"),
        license_jurisdiction: text("license_jurisdiction"),
        license_classification: text("license_classification"),
        additional_insured: text("additional_insured") === "true",
        primary_noncontributory: text("primary_noncontributory") === "true",
        waiver_of_subrogation: text("waiver_of_subrogation") === "true",
        share_after_upload: text("share_after_upload") === "true",
      },
      file,
    );
    revalidatePath("/trade/setup");
    return result;
  });
}

export async function shareOwnComplianceDocumentAction(input: unknown) {
  return runAction(async () => {
    const result = await shareOwnComplianceDocument(input);
    revalidatePath("/trade/setup");
    return result;
  });
}
