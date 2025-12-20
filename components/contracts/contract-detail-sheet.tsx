"use client"

import { format } from "date-fns"

import type { Contract } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

interface ContractDetailSheetProps {
  contract: Contract | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ContractDetailSheet({ contract, open, onOpenChange }: ContractDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader className="pb-4">
          <SheetTitle>Contract</SheetTitle>
          <SheetDescription>Terms, value, and signature details.</SheetDescription>
        </SheetHeader>

        {!contract ? (
          <div className="text-sm text-muted-foreground">No contract available for this project.</div>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{contract.title}</CardTitle>
                  <p className="text-sm text-muted-foreground">{contract.number ?? "Unnumbered"}</p>
                </div>
                <Badge variant="secondary" className="capitalize">
                  {contract.status.replace("_", " ")}
                </Badge>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4 text-sm">
                <Info label="Type" value={contract.contract_type?.replace("_", " ") ?? "—"} />
                <Info
                  label="Value"
                  value={
                    typeof contract.total_cents === "number"
                      ? formatCurrency(contract.total_cents, contract.currency)
                      : "—"
                  }
                />
                <Info label="Markup" value={contract.markup_percent ? `${contract.markup_percent}%` : "—"} />
                <Info
                  label="Retainage"
                  value={
                    contract.retainage_percent
                      ? `${contract.retainage_percent}%${contract.retainage_release_trigger ? ` • ${contract.retainage_release_trigger}` : ""}`
                      : "—"
                  }
                />
                <Info label="Effective" value={contract.effective_date ? formatDate(contract.effective_date) : "—"} />
                <Info label="Signed" value={contract.signed_at ? formatDate(contract.signed_at) : "—"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Terms</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="max-h-64 pr-3">
                  <div className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {contract.terms ? contract.terms : "No terms provided."}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Signature</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {contract.signature_data?.signature_svg ? (
                  <div className="rounded-md border bg-muted/40 p-3">
                    <div
                      className="signature-preview"
                      dangerouslySetInnerHTML={{ __html: contract.signature_data.signature_svg }}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Not signed yet.</p>
                )}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Info label="Signer" value={contract.signature_data?.signer_name ?? "—"} />
                  <Info label="Signed at" value={contract.signature_data?.signed_at ? formatDate(contract.signature_data.signed_at) : "—"} />
                  <Info label="IP" value={contract.signature_data?.signer_ip ?? "—"} />
                </div>
              </CardContent>
            </Card>

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" disabled>
                Download PDF
              </Button>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
      <Separator className="opacity-0" />
    </div>
  )
}

function formatDate(value: string) {
  return format(new Date(value), "MMM d, yyyy")
}

function formatCurrency(cents: number, currency: string) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 })
}
