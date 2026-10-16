"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { PackageCheck } from "lucide-react"

import { ReceiveDeliveryDialog } from "@/components/purchasing/receive-delivery-dialog"
import { Button } from "@/components/ui/button"

/** Opens the receive dialog for a home from a surface that is not the order's sheet. */
export function ReceiveDeliveryButton({ projectId, commitmentId, lineId, label = "Receive against PO", className }: {
  projectId: string
  commitmentId?: string
  lineId?: string
  label?: string
  className?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return <>
    <Button type="button" variant="ghost" size="sm" className={className} onClick={() => setOpen(true)}><PackageCheck /> {label}</Button>
    {open && <ReceiveDeliveryDialog projectId={projectId} commitmentId={commitmentId} lineId={lineId} open onOpenChange={setOpen} onDone={() => router.refresh()} />}
  </>
}
