import "server-only"

import { tool, zodSchema } from "ai"

import {
  buildAiActionDraft,
  createAiSearchActionRequest,
} from "@/lib/services/ai-search/actions"
import {
  addAction,
  addMissingData,
  recordToolSummary,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"
import {
  aiAssistantToolOutputSchema,
  createTaskInputSchema,
  type AiAssistantToolOutput,
  type CreateTaskInput,
} from "@/lib/validation/ai-assistant"

export function createActionTools({
  context,
  state,
  sessionId,
}: {
  context: OrgServiceContext
  state: AssistantToolState
  sessionId: string
}) {
  return {
    create_task: tool<CreateTaskInput, AiAssistantToolOutput>({
      description:
        "Draft a task creation action. This always returns an approval-required preview/action request; it never creates the task directly.",
      inputSchema: zodSchema(createTaskInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        if (!input.title) {
          const question = "What should the task be called?"
          addMissingData(state, ["Task title is required before drafting a task action."])
          recordToolSummary(state, "create_task", question)
          return {
            narrative_summary: question,
            rows: 0,
            result_refs: [],
            ask_user: {
              question,
              input: "text" as const,
            },
            missing_data: ["Task title is required."],
          }
        }

        const draft = buildAiActionDraft("tasks.create", {
          title: input.title,
          description: input.description,
          dueDate: input.dueDate,
          projectId: input.projectId,
          projectName: input.projectName,
          assigneeId: input.assigneeId,
          assigneeHint: input.assigneeHint,
        })

        if (!draft) {
          const summary = "Task action drafting is unavailable right now."
          addMissingData(state, [summary])
          recordToolSummary(state, "create_task", summary)
          return {
            narrative_summary: summary,
            rows: 0,
            result_refs: [],
            missing_data: [summary],
          }
        }

        const action = await createAiSearchActionRequest(context, {
          sessionId,
          toolKey: "tasks.create",
          title: draft.title,
          summary: draft.summary,
          args: draft.args,
          requiresApproval: true,
        })

        addAction(state, action)
        const summary = "Drafted a task action. It requires user approval before anything is created."
        recordToolSummary(state, "create_task", summary)
        return {
          narrative_summary: summary,
          rows: 1,
          result_refs: [],
          requires_approval: true,
          action_id: action.id,
          missing_data: [],
        }
      },
    }),
  }
}
