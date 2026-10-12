"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"

import { completeAgreementCancellationAction } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"

/** Finishes a cancellation's refund, forfeiture and access steps; what already happened is not repeated. */
export function CancellationSettlementRetry({ cancellationId }: { cancellationId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const retry = () => startTransition(async () => {
    try {
      unwrapAction(await completeAgreementCancellationAction({ cancellationId }))
      toast({ title: "Cancellation settled" })
    } catch (error) {
      toast({ title: "Settlement did not finish", description: (error as Error).message })
    }
    router.refresh()
  })
  return (
    <Button size="sm" variant="outline" className="mt-2 h-7" disabled={pending} onClick={retry}>
      {pending ? "Settling…" : "Retry settlement"}
    </Button>
  )
}
