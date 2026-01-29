"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Search, Filter, X, Plus, UserPlus } from "@/components/icons"

interface CustomerFiltersProps {
  search: string
  status: string
  plan: string
  onProvision?: () => void
}

export function CustomerFilters({ search, status, plan, onProvision }: CustomerFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [localSearch, setLocalSearch] = useState(search)

  const updateFilters = (updates: Partial<CustomerFiltersProps>) => {
    const params = new URLSearchParams(searchParams.toString())

    Object.entries(updates).forEach(([key, value]) => {
      if (typeof value === 'string' && value && value !== 'all') {
        params.set(key, value)
      } else if (typeof value === 'string') {
        params.delete(key)
      }
    })

    // Reset to page 1 when filters change
    params.delete('page')

    router.push(`/admin/customers?${params.toString()}`)
  }

  const clearFilters = () => {
    router.push('/admin/customers')
    setLocalSearch('')
  }

  const hasActiveFilters = search || (status && status !== 'all') || (plan && plan !== 'all')

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 items-center gap-2">
        <Input
          placeholder="Search customers..."
          className="w-full sm:w-72"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              updateFilters({ search: localSearch })
            }
          }}
        />
        <Select value={status} onValueChange={(value) => updateFilters({ status: value })}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
        <Select value={plan} onValueChange={(value) => updateFilters({ plan: value })}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Plan" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            <SelectItem value="subscription">Subscription</SelectItem>
            <SelectItem value="license">License</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
          >
            <X className="h-4 w-4 mr-2" />
            Clear filters
          </Button>
        )}
        <Button
          onClick={onProvision}
          size="sm"
        >
          <Plus className="h-4 w-4 mr-2" />
          Provision Customer
        </Button>
      </div>
    </div>
  )
}