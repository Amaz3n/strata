"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/action-result";
import {
  previewProjectPayrollAllocation,
  prepareProjectPayrollAllocation,
} from "@/lib/services/books/payroll-allocation-preview";

export async function previewProjectPayrollAllocationAction(input: unknown) {
  return runAction(() => previewProjectPayrollAllocation(input));
}
export async function prepareProjectPayrollAllocationAction(input: unknown) {
  return runAction(() => prepareProjectPayrollAllocation(input));
}
import {
  previewPayrollWorkerLabor,
  readProjectPayrollWorkers,
} from "@/lib/services/books/payroll-worker-labor";

export async function loadProjectPayrollWorkersAction(
  input: Parameters<typeof readProjectPayrollWorkers>[0],
) {
  return runAction(() => readProjectPayrollWorkers(input));
}

export async function previewProjectPayrollWorkerLaborAction(input: unknown) {
  return runAction(() => previewPayrollWorkerLabor(input));
}
import {
  preparePrivatePayrollUpload,
  inspectProjectPrivatePayrollUpload,
} from "@/lib/services/books/payroll-documents";

export async function prepareProjectPayrollUploadAction(input: unknown) {
  return runAction(() => preparePrivatePayrollUpload(input));
}
export async function inspectProjectPayrollUploadAction(
  input: Parameters<typeof inspectProjectPrivatePayrollUpload>[0],
) {
  return runAction(() => inspectProjectPrivatePayrollUpload(input));
}
import {
  getProjectPayrollCorrectionWorkspace,
  getProjectPayrollCorrectionDetail,
  requireProjectPayrollCorrectionSource,
  requireProjectPayrollCorrectionProposal,
} from "@/lib/services/books/payroll-correction-workspace";
import {
  getPayrollCorrectionContext,
  reviewPayrollCorrectionSource,
  withdrawPayrollCorrectionSource,
} from "@/lib/services/books/payroll-corrections";
import {
  preparePayrollCorrectionProposal,
  reviewPayrollCorrectionProposal,
  withdrawPayrollCorrectionProposal,
  postPayrollCorrectionProposal,
} from "@/lib/services/books/payroll-correction-proposals";

export async function loadProjectPayrollCorrectionsAction(
  projectId: string,
  cursor?: unknown,
) {
  return runAction(() =>
    getProjectPayrollCorrectionWorkspace(projectId, cursor),
  );
}
export async function loadProjectPayrollCorrectionAction(input: {
  projectId: string;
  sourceId: string;
}) {
  return runAction(() => getProjectPayrollCorrectionDetail(input));
}
export async function previewProjectPayrollPlacementAction(input: {
  projectId: string;
  sourceId: string;
  constructionDecisions: unknown;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionSource(
      input.projectId,
      input.sourceId,
    );
    return getPayrollCorrectionContext({
      id: input.sourceId,
      constructionDecisions: input.constructionDecisions,
    });
  });
}
export async function reviewProjectPayrollSourceAction(input: {
  projectId: string;
  sourceId: string;
  notes: string;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionSource(
      input.projectId,
      input.sourceId,
    );
    const id = await reviewPayrollCorrectionSource({
      id: input.sourceId,
      notes: input.notes,
    });
    revalidatePath(
      `/projects/${z.string().uuid().parse(input.projectId)}/time/payroll`,
    );
    return id;
  });
}
export async function prepareProjectPayrollProposalAction(input: {
  projectId: string;
  sourceId: string;
  id: string;
  notes: string;
  idempotencyKey: string;
  constructionDecisions?: unknown;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionSource(
      input.projectId,
      input.sourceId,
    );
    const id = await preparePayrollCorrectionProposal(input);
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}
export async function reviewProjectPayrollProposalAction(input: {
  projectId: string;
  proposalId: string;
  notes: string;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionProposal(
      input.projectId,
      input.proposalId,
    );
    const id = await reviewPayrollCorrectionProposal({
      id: input.proposalId,
      notes: input.notes,
    });
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}
export async function withdrawProjectPayrollProposalAction(input: {
  projectId: string;
  proposalId: string;
  notes: string;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionProposal(
      input.projectId,
      input.proposalId,
    );
    const id = await withdrawPayrollCorrectionProposal({
      id: input.proposalId,
      reason: input.notes,
    });
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}
export async function postProjectPayrollProposalAction(input: {
  projectId: string;
  proposalId: string;
  id: string;
  planDigest: string;
  notes: string;
  idempotencyKey: string;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionProposal(
      input.projectId,
      input.proposalId,
    );
    const result = await postPayrollCorrectionProposal(input);
    revalidatePath(`/projects/${input.projectId}/time`);
    revalidatePath(`/projects/${input.projectId}/financials`);
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return result;
  });
}

export async function withdrawProjectPayrollSourceAction(input: {
  projectId: string;
  sourceId: string;
  notes: string;
}) {
  return runAction(async () => {
    await requireProjectPayrollCorrectionSource(
      input.projectId,
      input.sourceId,
    );
    const id = await withdrawPayrollCorrectionSource({
      id: input.sourceId,
      reason: input.notes,
    });
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}

import {
  getProjectPayrollDrafts,
  getProjectPayrollDraftDetail,
  reviewProjectPayrollDraft,
  withdrawProjectPayrollDraft,
} from "@/lib/services/books/payroll-draft-workspace";
export async function loadProjectPayrollDraftsAction(
  projectId: string,
  cursor?: unknown,
) {
  return runAction(() => getProjectPayrollDrafts(projectId, cursor));
}
export async function loadProjectPayrollDraftAction(
  input: Parameters<typeof getProjectPayrollDraftDetail>[0],
) {
  return runAction(() => getProjectPayrollDraftDetail(input));
}
export async function reviewProjectPayrollDraftAction(
  input: Parameters<typeof reviewProjectPayrollDraft>[0],
) {
  return runAction(async () => {
    const id = await reviewProjectPayrollDraft(input);
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}
export async function withdrawProjectPayrollDraftAction(
  input: Parameters<typeof withdrawProjectPayrollDraft>[0],
) {
  return runAction(async () => {
    const id = await withdrawProjectPayrollDraft(input);
    revalidatePath(`/projects/${input.projectId}/time/payroll`);
    return id;
  });
}

import {
  previewProjectPayrollPaymentReview,
  prepareProjectPayrollPaymentReview,
} from "@/lib/services/books/payroll-project-payment-review";
export async function previewProjectPayrollPaymentReviewAction(input: unknown) {
  return runAction(() => previewProjectPayrollPaymentReview(input));
}
export async function prepareProjectPayrollPaymentReviewAction(input: unknown) {
  return runAction(() => prepareProjectPayrollPaymentReview(input));
}

import { readProjectPayrollSupportVersions } from "@/lib/services/books/payroll-support-versions";
export async function loadProjectPayrollSupportVersionsAction(input: unknown) {
  return runAction(() => readProjectPayrollSupportVersions(input));
}

import {
  readProjectPayrollPaymentWorkspace,
  reviewProjectPayrollPaymentAttribution,
  withdrawProjectPayrollPaymentAttribution,
} from "@/lib/services/books/payroll-payment-workspace";
export async function loadProjectPayrollPaymentWorkspaceAction(input: unknown) {
  return runAction(() => readProjectPayrollPaymentWorkspace(input));
}
export async function reviewProjectPayrollPaymentAttributionAction(
  input: unknown,
) {
  return runAction(() => reviewProjectPayrollPaymentAttribution(input));
}
export async function withdrawProjectPayrollPaymentAttributionAction(
  input: unknown,
) {
  return runAction(() => withdrawProjectPayrollPaymentAttribution(input));
}
