import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"

// Master on/off switch for the conversational AI search feature. Default ON; platform
// admins can disable it per-org from the /platform page.
export const AI_SEARCH_ENABLED_FLAG_KEY = "ai_search_enabled"

export const AI_SEARCH_FEATURE_FLAGS = {
  enabled: AI_SEARCH_ENABLED_FLAG_KEY,
  plannerV2: "ai_search_planner_v2",
  hybridRetrieval: "ai_search_hybrid_retrieval",
  conversationMemory: "ai_search_memory",
  intentRouter: "ai_search_intent_router",
  multiStepPlanning: "ai_search_multistep_planner_v2",
  generalAssistant: "ai_search_general_assistant",
  evalHarness: "ai_search_eval_harness",
  agentHarness: "ai_search_agent_harness",
} as const

export interface AiSearchRuntimeFlags {
  enabled: boolean
  plannerV2: boolean
  hybridRetrieval: boolean
  conversationMemory: boolean
  intentRouter: boolean
  multiStepPlanning: boolean
  generalAssistant: boolean
  evalHarness: boolean
  agentHarness: boolean
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

// Lightweight standalone check for the master switch — used by the stream route guard and
// the client-facing config endpoint without resolving every AI search flag.
export async function isAiSearchEnabledForOrg(input: {
  supabase: SupabaseClient
  orgId: string
}): Promise<boolean> {
  return isFeatureEnabledForOrg({
    supabase: input.supabase,
    orgId: input.orgId,
    flagKey: AI_SEARCH_ENABLED_FLAG_KEY,
    defaultEnabled: parseEnvFlag("AI_SEARCH_ENABLED_DEFAULT", true),
  })
}

export async function getAiSearchRuntimeFlags(context: OrgServiceContext): Promise<AiSearchRuntimeFlags> {
  const enabledDefault = parseEnvFlag("AI_SEARCH_ENABLED_DEFAULT", true)
  const plannerDefault = parseEnvFlag("AI_SEARCH_PLANNER_V2_DEFAULT", true)
  const hybridDefault = parseEnvFlag("AI_SEARCH_HYBRID_RETRIEVAL_DEFAULT", true)
  const memoryDefault = parseEnvFlag("AI_SEARCH_MEMORY_DEFAULT", true)
  const intentRouterDefault = parseEnvFlag("AI_SEARCH_INTENT_ROUTER_DEFAULT", true)
  const multiStepDefault = parseEnvFlag("AI_SEARCH_MULTI_STEP_DEFAULT", true)
  const generalDefault = parseEnvFlag("AI_SEARCH_GENERAL_ASSISTANT_DEFAULT", true)
  const evalDefault = parseEnvFlag("AI_SEARCH_EVAL_HARNESS_DEFAULT", false)
  const agentHarnessDefault = parseEnvFlag("AI_SEARCH_AGENT_HARNESS_DEFAULT", true)

  const [
    enabled,
    plannerV2,
    hybridRetrieval,
    conversationMemory,
    intentRouter,
    multiStepPlanning,
    generalAssistant,
    evalHarness,
    agentHarness,
  ] = await Promise.all([
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.enabled,
      defaultEnabled: enabledDefault,
    }),
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
      flagKey: AI_SEARCH_FEATURE_FLAGS.intentRouter,
      defaultEnabled: intentRouterDefault,
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
    isFeatureEnabledForOrg({
      supabase: context.supabase,
      orgId: context.orgId,
      flagKey: AI_SEARCH_FEATURE_FLAGS.agentHarness,
      defaultEnabled: agentHarnessDefault,
    }),
  ])

  return {
    enabled,
    plannerV2,
    hybridRetrieval,
    conversationMemory,
    intentRouter,
    multiStepPlanning,
    generalAssistant,
    evalHarness,
    agentHarness,
  }
}
