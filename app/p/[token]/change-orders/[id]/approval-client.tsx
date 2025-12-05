"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder } from "@/lib/types"
import { approveChangeOrderAction } from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SignaturePad } from "@/components/portal/signature-pad"
import { Input } from "@/components/ui/input"

interface Props {
  token: string
  changeOrder: ChangeOrder & { requires_signature?: boolean | null }
}

export function ChangeOrderApprovalClient({ token, changeOrder }: Props) {
  const [signature, setSignature] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [isPending, startTransition] = useTransition()
  const [approved, setApproved] = useState(false)

  const handleApprove = () => {
    startTransition(async () => {
      try {
        await approveChangeOrderAction({ token, changeOrderId: changeOrder.id, signature, name })
        setApproved(true)
        toast.success("Change order approved")
      } catch (error: any) {
        console.error("Approval failed", error)
        toast.error(error?.message ?? "Approval failed")
      }
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="text-center space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Change Order</p>
          <h1 className="text-2xl font-bold">{changeOrder.title}</h1>
          <div className="flex justify-center gap-2">
            <Badge variant="secondary" className="capitalize">{changeOrder.status}</Badge>
            {changeOrder.days_impact != null && (
              <Badge variant="outline">Schedule impact: {changeOrder.days_impact} days</Badge>
            )}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {changeOrder.summary ? <p>{changeOrder.summary}</p> : <p>No summary provided.</p>}
            {changeOrder.description && <p className="whitespace-pre-line">{changeOrder.description}</p>}
            {changeOrder.total_cents != null && (
              <p className="text-lg font-semibold text-foreground">
                Total: ${(changeOrder.total_cents / 100).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approve</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Approving will notify the builder. {changeOrder.requires_signature ? "Signature is requested below." : ""}
            </p>
            <div className="space-y-2">
              <SignaturePad onChange={setSignature} />
              <Input
                placeholder="Type your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={approved}
              />
            </div>
            <Button
              onClick={handleApprove}
              disabled={
                approved ||
                isPending ||
                (changeOrder.requires_signature && !signature) ||
                name.trim().length === 0
              }
            >
              {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {approved ? "Approved" : "Approve change order"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

