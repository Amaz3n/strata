"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MoreHorizontal, Users, Calendar } from "@/components/icons"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { CustomerSheet } from "./customer-sheet"
import { ProvisionCustomerSheet } from "./provision-customer-sheet"
import { CustomerFilters } from "./customer-filters"

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
    planName: string
    amountCents: number
    currency: string
    interval: string
    currentPeriodEnd: string
  } | null
}

interface CustomersClientProps {
  customers: Customer[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
  search: string
  status: string
  plan: string
  page: number
  onProvision: (formData: FormData) => Promise<any>
}

export function CustomersClient({
  customers,
  totalCount,
  hasNextPage,
  hasPrevPage,
  search,
  status,
  plan,
  page,
  onProvision,
}: CustomersClientProps) {
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [provisionOpen, setProvisionOpen] = useState(false)
  const [provisioning, setProvisioning] = useState(false)

  const handleViewCustomer = (customer: Customer) => {
    setSelectedCustomer(customer)
    setSheetOpen(true)
  }

  const handleProvision = async (formData: FormData) => {
    setProvisioning(true)
    try {
      await onProvision(formData)
      window.location.reload()
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <div className="space-y-6">
      <CustomerFilters
        search={search}
        status={status}
        plan={plan}
        onProvision={() => setProvisionOpen(true)}
      />

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Organization</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Subscription</TableHead>
              <TableHead className="px-4 py-4 text-center">Plan</TableHead>
              <TableHead className="px-4 py-4 text-center">Amount</TableHead>
              <TableHead className="px-4 py-4 text-center">Members</TableHead>
              <TableHead className="px-4 py-4 text-center">Created</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 ? (
              <TableRow className="divide-x">
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Users className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No customers found</p>
                      <p className="text-sm">Try adjusting your search criteria.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              customers.map((customer) => (
                <TableRow key={customer.id} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>
                          {customer.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium">{customer.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {customer.slug}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant={getStatusVariant(customer.status)}>
                      {customer.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <Badge variant={customer.subscription.status === 'active' ? 'default' : 'secondary'}>
                        {customer.subscription.status}
                      </Badge>
                    ) : (
                      <Badge variant="outline">No subscription</Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <span className="text-sm">{customer.subscription.planName}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <div className="text-sm font-medium">
                        ${(customer.subscription.amountCents / 100).toFixed(0)}
                        <span className="text-muted-foreground">/{customer.subscription.interval}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="h-3 w-3" />
                      <span>{customer.memberCount}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <div className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(customer.createdAt), { addSuffix: true })}
                    </div>
                  </TableCell>
                  <TableCell className="text-center w-12 px-4 py-4">
                    <div className="flex justify-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleViewCustomer(customer)}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">View customer details</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {(hasNextPage || hasPrevPage) && (
        <div className="flex justify-between items-center">
          <Button
            variant="outline"
            disabled={!hasPrevPage}
            asChild={hasPrevPage}
          >
            {hasPrevPage ? (
              <Link href={`/admin/customers?page=${page - 1}&search=${search}&status=${status}&plan=${plan}`}>
                Previous
              </Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>

          <div className="text-sm text-muted-foreground">
            Page {page} • {totalCount} total customers
          </div>

          <Button
            variant="outline"
            disabled={!hasNextPage}
            asChild={hasNextPage}
          >
            {hasNextPage ? (
              <Link href={`/admin/customers?page=${page + 1}&search=${search}&status=${status}&plan=${plan}`}>
                Next
              </Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      )}

      <CustomerSheet
        customer={selectedCustomer}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      <ProvisionCustomerSheet
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        onProvision={handleProvision}
        loading={provisioning}
      />
    </div>
  )
}

function getStatusVariant(status: string) {
  switch (status) {
    case 'active':
      return 'default'
    case 'inactive':
      return 'secondary'
    case 'suspended':
      return 'destructive'
    default:
      return 'outline'
  }
}