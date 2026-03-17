import type { OrgServiceContext } from "@/lib/services/context"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"

export const AI_SEARCH_FEATURE_FLAGS = {
  plannerV2: "ai_search_planner_v2",
  hybridRetrieval: "ai_search_hybrid_retrieval",
  conversationMemory: "ai_search_memory",
  multiStepPlanning: "ai_search_multistep_planner_v2",
  generalAssistant: "ai_search_general_assistant",
  evalHarness: "ai_search_eval_harness",
} as const

export interface AiSearchRuntimeFlags {
  plannerV2: boolean
  hybridRetrieval: boolean
  conversationMemory: boolean
  multiStepPlanning: boolean
  generalAssistant: boolean
  evalHarness: boolean
}

function parseEnvFlag(name: string, fallback: boolean) {
  const raw = process.env[name]
  if (!raw) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false
  }
  return fallback
}

export async function getAiSearchRuntimeFlags(context: OrgServiceContext): Promise<AiSearchRuntimeFlags> {
  const plannerDefault = parseEnvFlag("AI_SEARCH_PLANNER_V2_DEFAULT", true)
  const hybridDefault = parseEnvFlag("AI_SEARCH_HYBRID_RETRIEVAL_DEFAULT", true)
  const memoryDefault = parseEnvFlag("AI_SEARCH_MEMORY_DEFAULT", true)
  const multiStepDefault = parseEnvFlag("AI_SEARCH_MULTI_STEP_DEFAULT", true)
  const generalDefault = parseEnvFlag("AI_SEARCH_GENERAL_ASSISTANT_DEFAULT", true)
  const evalDefault = parseEnvFlag("AI_SEARCH_EVAL_HARNESS_DEFAULT", false)

  const [plannerV2, hybridRetrieval, conversationMemory, multiStepPlanning, generalAssistant, evalHarness] = await Promise.all([
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.plannerV2,
      defaultEnabled: plannerDefault,
    }),
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.hybridRetrieval,
      defaultEnabled: hybridDefault,
    }),
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.conversationMemory,
      defaultEnabled: memoryDefault,
    }),
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.multiStepPlanning,
      defaultEnabled: multiStepDefault,
    }),
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.generalAssistant,
      defaultEnabled: generalDefault,
    }),
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.evalHarness,
      defaultEnabled: evalDefault,
    }),
  ])

  return {
    plannerV2,
    hybridRetrieval,
    conversationMemory,
    multiStepPlanning,
    generalAssistant,
    evalHarness,
  }
}
