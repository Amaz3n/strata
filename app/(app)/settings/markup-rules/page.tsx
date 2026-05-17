import { Percent, Trash2 } from "lucide-react"

import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createMarkupRuleFormAction, deleteMarkupRuleFormAction, listMarkupRuleOptionsAction, listMarkupRulesAction } from "./actions"

export const dynamic = "force-dynamic"

export default async function MarkupRulesPage() {
  const [rules, options] = await Promise.all([
    listMarkupRulesAction(),
    listMarkupRuleOptionsAction(),
  ])

  return (
    <PageLayout
      title="Markup Rules"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Markup Rules" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Markup Rules</h1>
          <p className="text-sm text-muted-foreground">Set default cost-plus markups by org, contract, or cost code.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Percent className="h-4 w-4" />
              New rule
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createMarkupRuleFormAction} className="grid gap-4 lg:grid-cols-[160px_1fr_1fr_140px_150px_150px_auto] lg:items-end">
              <div className="space-y-2">
                <Label>Scope</Label>
                <Select name="scope" defaultValue="org">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">Org</SelectItem>
                    <SelectItem value="contract">Contract</SelectItem>
                    <SelectItem value="cost_code">Cost code</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Contract</Label>
                <Select name="contract_id">
                  <SelectTrigger><SelectValue placeholder="Only for contract scope" /></SelectTrigger>
                  <SelectContent>
                    {options.contracts.map((contract: any) => (
                      <SelectItem key={contract.id} value={contract.id}>
                        {contract.title ?? contract.number ?? "Contract"} {contract.project?.name ? `- ${contract.project.name}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select name="cost_code_id">
                  <SelectTrigger><SelectValue placeholder="Only for cost-code scope" /></SelectTrigger>
                  <SelectContent>
                    {options.costCodes.map((code: any) => (
                      <SelectItem key={code.id} value={code.id}>{code.code} {code.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Markup %</Label>
                <Input name="markup_percent" type="number" min="0" max="200" step="0.01" required />
              </div>
              <div className="space-y-2">
                <Label>Effective from</Label>
                <Input name="effective_from" type="date" />
              </div>
              <div className="space-y-2">
                <Label>Effective to</Label>
                <Input name="effective_to" type="date" />
              </div>
              <Button type="submit">Add rule</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active rules</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scope</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Markup</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="capitalize">{rule.scope.replace("_", " ")}</TableCell>
                    <TableCell>{rule.contract_name ?? ([rule.cost_code_code, rule.cost_code_name].filter(Boolean).join(" ") || "Org default")}</TableCell>
                    <TableCell>{rule.markup_percent}%</TableCell>
                    <TableCell>{formatRange(rule.effective_from, rule.effective_to)}</TableCell>
                    <TableCell className="text-right">
                      <form action={deleteMarkupRuleFormAction.bind(null, rule.id)}>
                        <Button size="icon" variant="ghost" aria-label="Delete markup rule">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
                {rules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No markup rules yet.</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}

function formatRange(from?: string | null, to?: string | null) {
  if (!from && !to) return "Always"
  return `${from ?? "Start"} to ${to ?? "Open"}`
}
