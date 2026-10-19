"use server";

import { revalidatePath } from "next/cache";
import { actionError, type ActionResult } from "@/lib/action-result";
import {
  answerProposalComment,
  saveDealProposal,
  saveProposalDefault,
} from "@/lib/services/precon-proposal";

async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return actionError(error);
  }
}

// Autosave: the room holds the live proposal, so re-running the deal's loaders
// on every keystroke would only fight the editor.
export async function saveDealProposalAction(prospectId: string, input: unknown, version: number) {
  return attempt(() => saveDealProposal(prospectId, input, version));
}

export async function saveProposalDefaultAction(prospectId: string, input: unknown) {
  return attempt(() => saveProposalDefault(prospectId, input));
}

export async function answerProposalCommentAction(prospectId: string, commentId: string, body: string) {
  return attempt(async () => {
    const answer = await answerProposalComment(prospectId, commentId, body);
    revalidatePath("/pipeline", "layout");
    return answer;
  });
}
