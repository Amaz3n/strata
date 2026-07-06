import "server-only"

import { createActionTools } from "@/lib/services/ai-assistant/tools/actions"
import { createAnalyticsTools } from "@/lib/services/ai-assistant/tools/analytics"
import { createAskUserTools } from "@/lib/services/ai-assistant/tools/ask-user"
import { createFinanceTools } from "@/lib/services/ai-assistant/tools/finance"
import { createSearchTools } from "@/lib/services/ai-assistant/tools/search"
import type { AssistantToolState } from "@/lib/services/ai-assistant/state"
import type { OrgServiceContext } from "@/lib/services/context"

export function createAiAssistantTools({
  context,
  state,
  sessionId,
  defaultLimit,
  enableHybridRetrieval,
  allowMutations,
}: {
  context: OrgServiceContext
  state: AssistantToolState
  sessionId: string
  defaultLimit: number
  enableHybridRetrieval: boolean
  allowMutations: boolean
}) {
  return {
    ...createSearchTools({
      context,
      state,
      defaultLimit,
      enableHybridRetrieval,
    }),
    ...createFinanceTools({
      context,
      state,
      defaultLimit,
      enableHybridRetrieval,
    }),
    ...createAnalyticsTools({
      context,
      state,
      defaultLimit,
      enableHybridRetrieval,
    }),
    ...(allowMutations
      ? createActionTools({
          context,
          state,
          sessionId,
        })
      : {}),
    ...createAskUserTools({ state }),
  }
}
