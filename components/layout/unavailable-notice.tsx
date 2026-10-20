import type { SurfaceRefusal } from "@/lib/workspace-surface"

/** What the member can do about each kind of refusal; a setup refusal already says it in its own sentence. */
const NEXT_STEP: Record<SurfaceRefusal["kind"], string | null> = {
  plan: "Ask an owner about your plan if your company needs it.",
  shape: "Ask an owner about your plan if your company needs it.",
  setup: null,
}

/** Names why a route sent the member home: the plan, the business profile or unfinished setup. */
export function UnavailableNotice({ refusal }: { refusal: SurfaceRefusal | null }) {
  if (!refusal) return null
  const nextStep = NEXT_STEP[refusal.kind]
  return (
    <p role="status" className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground">
      {refusal.message}
      {nextStep ? ` ${nextStep}` : null}
    </p>
  )
}
