export const FEATURE_FLAGS = {
  warrantyActorAnalytics: "warranty_actor_analytics",
  warrantyCompletionTransactions: "warranty_completion_transactions",
  warrantyCourtesyReservations: "warranty_courtesy_reservations",
  startsConfirmationRecovery: "starts_confirmation_recovery",
  notificationDeliveryReceipts: "notification_delivery_receipts",
  planDrawingCopyTransactions: "plan_drawing_copy_transactions",
  productionConfigurationRules: "production_configuration_rules",
  aiEnabled: "ai_enabled",
  aiSearchEnabled: "ai_search_enabled",
  aiSearchPlannerV2: "ai_search_planner_v2",
  aiSearchHybridRetrieval: "ai_search_hybrid_retrieval",
  aiSearchMemory: "ai_search_memory",
  aiSearchIntentRouter: "ai_search_intent_router",
  aiSearchMultiStepPlanning: "ai_search_multistep_planner_v2",
  aiSearchGeneralAssistant: "ai_search_general_assistant",
  aiSearchEvalHarness: "ai_search_eval_harness",
  betaFeatures: "beta_features",
  billingAutopilot: "billing_autopilot",
  fintechApPayments: "fintech_ap_payments",
  unifiedEsign: "unified_esign",
} as const

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

export interface FeatureFlagDefinition {
  key: FeatureFlagKey
  label: string
  description: string
  owner: "ai" | "billing" | "esign" | "payments" | "platform"
  defaultEnabled: boolean
  reviewAfter: string
  removalCondition: string
  config: Record<string, unknown>
}

const REVIEW_AFTER = "2026-10-01"

export const FEATURE_FLAG_DEFINITIONS: Record<FeatureFlagKey, FeatureFlagDefinition> = {
  [FEATURE_FLAGS.warrantyActorAnalytics]: { key: FEATURE_FLAGS.warrantyActorAnalytics, label: "Scoped warranty analytics", description: "Actor-scoped database aggregates. Enable only after migration approval, full-schema policy and accounting-source acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove after every warranty aggregate uses verified actor/home scoping.", config: {} },
  [FEATURE_FLAGS.warrantyCompletionTransactions]: { key: FEATURE_FLAGS.warrantyCompletionTransactions, label: "Warranty completion transactions", description: "Atomic office completion with original event/audit and permanent replay receipts. Enable only after migration approval, full-schema concurrency and dedicated-QA acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove after all office completion uses verified transaction receipts and legacy completion is retired.", config: {} },
  [FEATURE_FLAGS.startsConfirmationRecovery]: { key: FEATURE_FLAGS.startsConfirmationRecovery, label: "Starts confirmation recovery", description: "Audited recovery of failed confirmation jobs for released homes. Enable after migration approval and dedicated-QA acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove after all organizations use the verified recovery transaction.", config: {} },
  [FEATURE_FLAGS.warrantyCourtesyReservations]: { key: FEATURE_FLAGS.warrantyCourtesyReservations, label: "Warranty courtesy reservations", description: "Reserve courtesy milestones atomically with request, event and audit evidence. Enable only after the migration and dedicated-QA acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove after all courtesy scheduling uses verified permanent reservations and legacy generation is retired.", config: {} },
  [FEATURE_FLAGS.notificationDeliveryReceipts]: { key: FEATURE_FLAGS.notificationDeliveryReceipts, label: "Notification delivery receipts", description: "Reserve stable alert deliveries with permanent receipts. Enable only after the receipt migration, recovery and dedicated-QA acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove after stable alert deliveries use verified receipts across all organizations and legacy enqueue is retired.", config: {} },
  [FEATURE_FLAGS.planDrawingCopyTransactions]: { key: FEATURE_FLAGS.planDrawingCopyTransactions, label: "Plan drawing copy transactions", description: "Durable copy reservations and atomic drawing publication. Enable only after staged migrations, ownership recovery and QA cutover acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove the rollout gate after all organizations use verified transactional drawing publication and the legacy path is retired.", config: {} },
  [FEATURE_FLAGS.productionConfigurationRules]: { key: FEATURE_FLAGS.productionConfigurationRules, label: "Production configuration rules", description: "Required and incompatible options at selection, sale and release. Enable only after the configuration migration and QA acceptance.", owner: "platform", defaultEnabled: false, reviewAfter: "2026-11-01", removalCondition: "Remove the rollout gate after all organizations have the schema and validated configuration controls.", config: {} },
  [FEATURE_FLAGS.aiEnabled]: { key: FEATURE_FLAGS.aiEnabled, label: "AI platform", description: "Master gate for AI provider execution.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after AI availability has one supported posture.", config: {} },
  [FEATURE_FLAGS.aiSearchEnabled]: { key: FEATURE_FLAGS.aiSearchEnabled, label: "AI Search", description: "Master switch for conversational AI search.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove when conversational search is universally supported or retired.", config: {} },
  [FEATURE_FLAGS.aiSearchPlannerV2]: { key: FEATURE_FLAGS.aiSearchPlannerV2, label: "AI Search Planner v2", description: "Second-generation search planner.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after the legacy planner is deleted.", config: {} },
  [FEATURE_FLAGS.aiSearchHybridRetrieval]: { key: FEATURE_FLAGS.aiSearchHybridRetrieval, label: "AI hybrid retrieval", description: "Hybrid lexical and semantic retrieval.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after retrieval evaluation selects one implementation.", config: {} },
  [FEATURE_FLAGS.aiSearchMemory]: { key: FEATURE_FLAGS.aiSearchMemory, label: "AI conversation memory", description: "Conversation-scoped search memory.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove when memory is a stable contract or is retired.", config: {} },
  [FEATURE_FLAGS.aiSearchIntentRouter]: { key: FEATURE_FLAGS.aiSearchIntentRouter, label: "AI intent router", description: "Routes requests to specialized search paths.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after the router is the only supported path.", config: {} },
  [FEATURE_FLAGS.aiSearchMultiStepPlanning]: { key: FEATURE_FLAGS.aiSearchMultiStepPlanning, label: "AI multi-step planner", description: "Multi-step conversational search planning.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after planner evaluation and legacy-path deletion.", config: {} },
  [FEATURE_FLAGS.aiSearchGeneralAssistant]: { key: FEATURE_FLAGS.aiSearchGeneralAssistant, label: "AI general assistant", description: "General-assistant behavior outside structured search intents.", owner: "ai", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove when assistant scope is a stable product contract.", config: {} },
  [FEATURE_FLAGS.aiSearchEvalHarness]: { key: FEATURE_FLAGS.aiSearchEvalHarness, label: "AI evaluation harness", description: "Organization access to AI evaluation tooling.", owner: "ai", defaultEnabled: false, reviewAfter: REVIEW_AFTER, removalCondition: "Remove when evaluation is platform-only or universally available.", config: {} },
  [FEATURE_FLAGS.betaFeatures]: { key: FEATURE_FLAGS.betaFeatures, label: "Beta Features", description: "General access to explicitly experimental capabilities.", owner: "platform", defaultEnabled: false, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after every consumer has a dedicated lifecycle.", config: {} },
  [FEATURE_FLAGS.billingAutopilot]: { key: FEATURE_FLAGS.billingAutopilot, label: "Arc Autopilot", description: "Experimental billing analysis and review workspace.", owner: "billing", defaultEnabled: false, reviewAfter: REVIEW_AFTER, removalCondition: "Remove when the workspace launches or is retired.", config: { experimental: true, mode: "review_only" } },
  [FEATURE_FLAGS.fintechApPayments]: { key: FEATURE_FLAGS.fintechApPayments, label: "Fintech AP Payments", description: "Electronic vendor payment execution in addition to the platform environment gate.", owner: "payments", defaultEnabled: false, reviewAfter: REVIEW_AFTER, removalCondition: "Retain as a kill switch while Arc moves money; review ownership quarterly.", config: { rail: "ach", provider: "stripe" } },
  [FEATURE_FLAGS.unifiedEsign]: { key: FEATURE_FLAGS.unifiedEsign, label: "Unified e-sign", description: "Unified document-envelope signing workflow.", owner: "esign", defaultEnabled: true, reviewAfter: REVIEW_AFTER, removalCondition: "Remove after all legacy signing paths are deleted.", config: {} },
}

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAG_DEFINITIONS) as FeatureFlagKey[]

export function getFeatureFlagDefinition(key: string) {
  return FEATURE_FLAG_DEFINITIONS[key as FeatureFlagKey]
}
