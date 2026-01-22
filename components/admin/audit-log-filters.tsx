"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Search, Filter, X } from "@/components/icons"

interface AuditLogFiltersProps {
  search: string
  action: string
  entityType: string
  user: string
}

export function AuditLogFilters({ search, action, entityType, user }: AuditLogFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [localSearch, setLocalSearch] = useState(search)

  const updateFilters = (updates: Partial<AuditLogFiltersProps>) => {
    const params = new URLSearchParams(searchParams.toString())

    Object.entries(updates).forEach(([key, value]) => {
      if (value && value !== 'all') {
        params.set(key, value)
      } else {
        params.delete(key)
      }
    })

    // Reset to page 1 when filters change
    params.delete('page')

    router.push(`/admin/audit?${params.toString()}`)
  }

  const clearFilters = () => {
    router.push('/admin/audit')
    setLocalSearch('')
  }

  const hasActiveFilters = search || (action && action !== 'all') || (entityType && entityType !== 'all') || (user && user !== 'all')

  return (
    <div className="flex flex-col sm:flex-row gap-4 mb-6">
      <div className="flex-1">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search audit log..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                updateFilters({ search: localSearch })
              }
            }}
            className="pl-9"
          />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Select value={action} onValueChange={(value) => updateFilters({ action: value })}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            <SelectItem value="insert">Create</SelectItem>
            <SelectItem value="update">Update</SelectItem>
            <SelectItem value="delete">Delete</SelectItem>
          </SelectContent>
        </Select>

        <Select value={entityType} onValueChange={(value) => updateFilters({ entityType: value })}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Entity Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="org">Organization</SelectItem>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="subscription">Subscription</SelectItem>
            <SelectItem value="payment">Payment</SelectItem>
            <SelectItem value="invoice">Invoice</SelectItem>
            <SelectItem value="project">Project</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => updateFilters({ search: localSearch })}
        >
          <Filter className="h-4 w-4 mr-2" />
          Apply
        </Button>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
          >
            <X className="h-4 w-4 mr-2" />
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}