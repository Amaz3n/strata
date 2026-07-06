import "server-only"

import { tool, zodSchema } from "ai"

import {
  addMissingData,
  recordToolSummary,
  type AssistantToolState,
} from "@/lib/services/ai-assistant/state"
import {
  aiAssistantToolOutputSchema,
  askUserInputSchema,
  type AiAssistantToolOutput,
  type AskUserInput,
} from "@/lib/validation/ai-assistant"

export function createAskUserTools({ state }: { state: AssistantToolState }) {
  return {
    ask_user: tool<AskUserInput, AiAssistantToolOutput>({
      description:
        "Ask the user one concise clarifying question when a required field is missing or ambiguous.",
      inputSchema: zodSchema(askUserInputSchema),
      outputSchema: zodSchema(aiAssistantToolOutputSchema),
      strict: true,
      execute: async (input) => {
        addMissingData(state, ["User clarification is required."])
        recordToolSummary(state, "ask_user", input.question)
        return {
          narrative_summary: input.question,
          rows: 0,
          result_refs: [],
          ask_user: input,
          missing_data: ["User clarification is required."],
        }
      },
    }),
  }
}
