import { AlertTriangle, CheckCircle2, FileSignature } from "lucide-react"
import type { ReactNode } from "react"

import { signTmTicketFormAction } from "@/app/t/[token]/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getTmTicketBySignatureToken } from "@/lib/services/tm-tickets"

export const revalidate = 0
export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

interface PageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ signed?: string }>
}

export default async function TmTicketSigningPage({ params, searchParams }: PageProps) {
  const { token } = await params
  const { signed } = await searchParams

  if (signed === "1") {
    return (
      <StatusPanel
        title="Ticket signed"
        description="Thank you. The signed T&M ticket has been sent back to the project team for billing."
        icon={<CheckCircle2 className="h-7 w-7 text-emerald-700" />}
      />
    )
  }

  const ticket = await getTmTicketBySignatureToken(token)
  if (!ticket) {
    return (
      <StatusPanel
        title="Link unavailable"
        description="This T&M ticket link is invalid, expired, already signed, or no longer available."
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  if (ticket.signature_token_expires_at && new Date(ticket.signature_token_expires_at) < new Date()) {
    return (
      <StatusPanel
        title="Link expired"
        description="This T&M ticket signature link has expired. Please ask the project team to send a new link."
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  return (
    <main className="min-h-screen bg-muted/20 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card>
          <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <FileSignature className="h-6 w-6" />
                {ticket.ticket_number}
              </CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Work date {formatDate(ticket.work_date)}
              </p>
            </div>
            <Badge variant="outline">{ticket.status.replaceAll("_", " ")}</Badge>
          </CardHeader>
          <CardContent className="space-y-5">
            {ticket.notes ? (
              <div className="border bg-background p-3 text-sm">
                {ticket.notes}
              </div>
            ) : null}
            <div className="rounded-md border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Billable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ticket.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.description ?? sourceLabel(item.source_type)}</div>
                        {item.metadata?.cost_code ? (
                          <div className="text-xs text-muted-foreground">
                            {[item.metadata.cost_code.code, item.metadata.cost_code.name].filter(Boolean).join(" ")}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{formatDate(item.occurred_on)}</TableCell>
                      <TableCell className="text-right">{formatQuantity(item.quantity)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(item.billable_cents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between border-t pt-4">
              <span className="text-sm text-muted-foreground">{ticket.totals.item_count} item{ticket.totals.item_count === 1 ? "" : "s"}</span>
              <span className="text-2xl font-semibold">{formatCurrency(ticket.totals.billable_cents)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client signature</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={signTmTicketFormAction.bind(null, token)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="signer_name">Name</Label>
                  <Input id="signer_name" name="signer_name" required autoComplete="name" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signer_email">Email</Label>
                  <Input id="signer_email" name="signer_email" type="email" autoComplete="email" />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm text-muted-foreground">
                <input name="accepted" type="checkbox" required className="mt-1" />
                <span>I approve this time-and-materials ticket and authorize it for billing.</span>
              </label>
              <div className="flex justify-end">
                <Button type="submit">Sign ticket</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function StatusPanel({
  title,
  description,
  icon,
}: {
  title: string
  description: string
  icon: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-xl rounded-lg">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border bg-muted/40">
            {icon}
          </div>
          <CardTitle className="text-2xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          {description}
        </CardContent>
      </Card>
    </div>
  )
}

function sourceLabel(sourceType: string) {
  return sourceType.replaceAll("_", " ")
}

function formatDate(value?: string | null) {
  if (!value) return "No date"
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`))
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function formatCurrency(value?: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0) / 100)
}
