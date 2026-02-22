"use client"

import { useState } from "react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Building2, Users, Calendar, CreditCard, Eye, Edit } from "@/components/icons"

interface Customer {
  id: string
  name: string
  slug: string
  status: string
  billingModel: string
  memberCount: number
  createdAt: string
  subscription?: {
    status: string
    planName: string | null
    amountCents: number | null
    currency: string | null
    interval: string | null
    currentPeriodEnd: string | null
  } | null
}

interface CustomerSheetProps {
  customer: Customer | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CustomerSheet({ customer, open, onOpenChange }: CustomerSheetProps) {
  const [activeTab, setActiveTab] = useState("details")
  const [editMode, setEditMode] = useState(false)
  const [editedName, setEditedName] = useState("")
  const [editedSlug, setEditedSlug] = useState("")
  const [editedStatus, setEditedStatus] = useState("")

  const handleEdit = () => {
    if (customer) {
      setEditedName(customer.name)
      setEditedSlug(customer.slug)
      setEditedStatus(customer.status)
      setEditMode(true)
    }
  }

  const handleSave = () => {
    // TODO: Implement save functionality
    console.log("Saving customer:", {
      id: customer?.id,
      name: editedName,
      slug: editedSlug,
      status: editedStatus,
    })
    setEditMode(false)
  }

  const handleCancel = () => {
    setEditMode(false)
  }

  if (!customer) return null

  const statusColors = {
    active: "bg-success/15 text-success border-success/30",
    inactive: "bg-muted text-muted-foreground border-muted",
    suspended: "bg-destructive/15 text-destructive border-destructive/30",
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-primary/10 text-primary">
                {customer.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-lg truncate">{customer.name}</SheetTitle>
              <SheetDescription className="text-sm">
                {customer.slug} • {customer.status}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <TabsList className="grid w-full grid-cols-2 mx-6 mt-4">
              <TabsTrigger value="details" className="flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Details
              </TabsTrigger>
              <TabsTrigger value="subscription" className="flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Subscription
              </TabsTrigger>
            </TabsList>

            <div className="flex-1 overflow-hidden">
              <TabsContent value="details" className="h-full m-0">
                <div className="px-6 py-4 space-y-6">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4" />
                          Organization Details
                        </div>
                        {!editMode && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleEdit}
                          >
                            <Edit className="h-4 w-4 mr-2" />
                            Edit
                          </Button>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Organization Name
                          </Label>
                          {editMode ? (
                            <Input
                              value={editedName}
                              onChange={(e) => setEditedName(e.target.value)}
                            />
                          ) : (
                            <p className="text-sm font-medium">{customer.name}</p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Slug
                          </Label>
                          {editMode ? (
                            <Input
                              value={editedSlug}
                              onChange={(e) => setEditedSlug(e.target.value)}
                            />
                          ) : (
                            <p className="text-sm font-mono">{customer.slug}</p>
                          )}
                        </div>
                      </div>

                      <Separator />

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Status
                          </Label>
                          {editMode ? (
                            <Select value={editedStatus} onValueChange={setEditedStatus}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="inactive">Inactive</SelectItem>
                                <SelectItem value="suspended">Suspended</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary" className={`border ${statusColors[customer.status as keyof typeof statusColors] || statusColors.inactive}`}>
                              {customer.status}
                            </Badge>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Billing Model
                          </Label>
                          <div className="mt-1">
                            <Badge variant="outline" className="capitalize">
                              {customer.billingModel}
                            </Badge>
                          </div>
                        </div>
                      </div>

                      <Separator />

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Subscription Status
                          </Label>
                          <div className="mt-1">
                            {customer.subscription ? (
                              <Badge variant={customer.subscription.status === 'active' ? 'default' : 'secondary'}>
                                {customer.subscription.status}
                              </Badge>
                            ) : (
                              <Badge variant="outline">No active subscription</Badge>
                            )}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Plan
                          </Label>
                          <div className="mt-1">
                            {customer.subscription ? (
                              <span className="text-sm font-medium">{customer.subscription.planName}</span>
                            ) : (
                              <span className="text-sm text-muted-foreground">-</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Amount
                          </Label>
                          <div className="mt-1">
                            {customer.subscription ? (
                              <span className="text-sm font-medium">
                                ${((customer.subscription.amountCents || 0) / 100).toFixed(0)}/{customer.subscription.interval}
                              </span>
                            ) : (
                              <span className="text-sm text-muted-foreground">-</span>
                            )}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Next Billing
                          </Label>
                          <div className="mt-1">
                            {customer.subscription ? (
                              <span className="text-sm">
                                {customer.subscription.currentPeriodEnd ? format(new Date(customer.subscription.currentPeriodEnd), "MMM d, yyyy") : "N/A"}
                              </span>
                            ) : (
                              <span className="text-sm text-muted-foreground">-</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <Separator />

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Members
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{customer.memberCount}</span>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Created
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            <Calendar className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">{format(new Date(customer.createdAt), "MMM d, yyyy")}</span>
                          </div>
                        </div>
                      </div>

                      {editMode && (
                        <>
                          <Separator />
                          <div className="flex gap-2 pt-2">
                            <Button onClick={handleSave} className="flex-1">
                              Save Changes
                            </Button>
                            <Button variant="outline" onClick={handleCancel} className="flex-1">
                              Cancel
                            </Button>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>


              <TabsContent value="subscription" className="h-full m-0">
                <div className="px-6 py-4 space-y-6">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        Subscription Management
                      </CardTitle>
                      <CardDescription>
                        Manage billing and subscription settings
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="text-center py-8 text-muted-foreground">
                        <CreditCard className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p className="text-sm">Subscription management features</p>
                        <p className="text-xs mt-1">Coming soon</p>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 border-t bg-muted/30 p-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="w-full"
          >
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}