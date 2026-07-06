import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertPortalActionAccess, loadSubPortalData } from "@/lib/services/portal-access"
import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { submitPortalExpenseAction } from "./actions"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function PortalExpensePage({ params }: Props) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_submit_expenses",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const [data, costCodesResult] = await Promise.all([
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
    createServiceSupabaseClient()
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("code"),
  ])
  const costCodes = costCodesResult.data ?? []

  return (
    <div className="min-h-screen bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />
      <main className="mx-auto w-full max-w-xl px-4 py-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href={`/s/${token}`}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Submit expense</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={submitPortalExpenseAction.bind(null, token)} className="space-y-4" encType="multipart/form-data">
              <div className="space-y-2">
                <Label>Vendor</Label>
                <Input name="vendor_name" placeholder="Rental house, lumberyard, etc." />
              </div>
              <div className="space-y-2">
                <Label>Receipt or photo</Label>
                <Input name="receipt" type="file" accept="image/*,application/pdf" />
              </div>
              <div className="space-y-2">
                <Label>Date</Label>
                <Input name="expense_date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <Input name="amount" inputMode="decimal" required />
                </div>
                <div className="space-y-2">
                  <Label>Tax</Label>
                  <Input name="tax" inputMode="decimal" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select name="cost_code_id">
                  <SelectTrigger>
                    <SelectValue placeholder="Select cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    {costCodes.map((code: any) => (
                      <SelectItem key={code.id} value={code.id}>{code.code} {code.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payment method</Label>
                <Select name="payment_method">
                  <SelectTrigger>
                    <SelectValue placeholder="Select method" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="company_card">Company card</SelectItem>
                    <SelectItem value="credit_card">Credit card</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="ach">ACH</SelectItem>
                    <SelectItem value="reimbursable_personal">Personal reimbursement</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_billable" defaultChecked />
                Billable
              </label>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea name="description" rows={4} />
              </div>
              <Button type="submit" className="w-full">Submit expense</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
