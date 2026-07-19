"use server";

import { revalidatePath } from "next/cache";

import {
  createEstimateTemplate,
  deleteEstimateTemplate,
  listEstimateTemplates,
  updateEstimateTemplate,
  type EstimateTemplateInput,
} from "@/lib/services/estimate-templates";

import { actionError, type ActionResult } from "@/lib/action-result";
import { z } from "zod";
import {
  archiveBudgetTemplate,
  createBudgetTemplate,
  updateBudgetTemplate,
} from "@/lib/services/budget-templates";
import { budgetTemplateInputSchema } from "@/lib/validation/budget-templates";
import {
  createTemplate,
  deleteTemplate,
  updateTemplate,
} from "@/lib/services/schedule";
import { scheduleTemplateInputSchema } from "@/lib/validation/schedule";

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() };
  } catch (error) {
    return actionError(error);
  }
}

export async function listEstimateTemplatesAction() {
  return listEstimateTemplates();
}

export async function createEstimateTemplateAction(
  input: EstimateTemplateInput,
) {
  return run(async () => {
    const template = await createEstimateTemplate(input);
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function updateEstimateTemplateAction(
  id: string,
  input: EstimateTemplateInput,
) {
  return run(async () => {
    const template = await updateEstimateTemplate(id, input);
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function deleteEstimateTemplateAction(id: string) {
  return run(async () => {
    await deleteEstimateTemplate(id);
    revalidatePath("/settings/templates");
    return { success: true };
  });
}

export async function createBudgetTemplateAction(input: unknown) {
  return run(async () => {
    const template = await createBudgetTemplate(
      budgetTemplateInputSchema.parse(input),
    );
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function updateBudgetTemplateAction(id: string, input: unknown) {
  return run(async () => {
    const template = await updateBudgetTemplate(
      z.string().uuid().parse(id),
      budgetTemplateInputSchema.parse(input),
    );
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function archiveBudgetTemplateAction(id: string) {
  return run(async () => {
    await archiveBudgetTemplate(z.string().uuid().parse(id));
    revalidatePath("/settings/templates");
  });
}

export async function createScheduleTemplateAction(input: unknown) {
  return run(async () => {
    const template = await createTemplate(
      scheduleTemplateInputSchema.parse(input),
    );
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function updateScheduleTemplateAction(id: string, input: unknown) {
  return run(async () => {
    const template = await updateTemplate(
      z.string().uuid().parse(id),
      scheduleTemplateInputSchema.parse(input),
    );
    revalidatePath("/settings/templates");
    return template;
  });
}

export async function deleteScheduleTemplateAction(id: string) {
  return run(async () => {
    await deleteTemplate(z.string().uuid().parse(id));
    revalidatePath("/settings/templates");
  });
}
