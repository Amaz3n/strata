"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import {
  MapPin,
  Filter,
  CheckSquare,
  HelpCircle,
  ClipboardList,
  FileCheck,
  BookOpen,
  AlertTriangle,
  AlertCircle,
  ChevronRight,
  Trash2,
  ExternalLink,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings"
import type { DrawingPin, PinEntityType, PinStatus } from "@/app/drawings/actions"

// Entity type icons
const ENTITY_ICONS: Record<PinEntityType, React.ElementType> = {
  task: CheckSquare,
  rfi: HelpCircle,
  punch_list: ClipboardList,
  submittal: FileCheck,
  daily_log: BookOpen,
  observation: AlertTriangle,
  issue: AlertCircle,
}

// Status colors
const STATUS_COLORS: Record<string, string> = {
  open: "bg-red-500",
  in_progress: "bg-orange-500",
  closed: "bg-green-500",
  pending: "bg-yellow-500",
  approved: "bg-green-500",
  rejected: "bg-red-500",
}

interface PinsListProps {
  pins: DrawingPin[]
  onPinClick?: (pin: DrawingPin) => void
  onPinDelete?: (pinId: string) => Promise<void>
  onNavigateToEntity?: (pin: DrawingPin) => void
  className?: string
}

export function PinsList({
  pins,
  onPinClick,
  onPinDelete,
  onNavigateToEntity,
  className,
}: PinsListProps) {
  const [selectedTypes, setSelectedTypes] = useState<Set<PinEntityType>>(new Set())
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set())
  const [deletePin, setDeletePin] = useState<DrawingPin | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Filter pins
  const filteredPins = pins.filter((pin) => {
    if (selectedTypes.size > 0 && !selectedTypes.has(pin.entity_type)) return false
    if (selectedStatuses.size > 0 && pin.status && !selectedStatuses.has(pin.status))
      return false
    return true
  })

  // Get unique entity types and statuses for filter options
  const entityTypes = [...new Set(pins.map((p) => p.entity_type))]
  const statuses = [...new Set(pins.filter((p) => p.status).map((p) => p.status!))]

  // Group pins by entity type
  const groupedPins = filteredPins.reduce(
    (acc, pin) => {
      if (!acc[pin.entity_type]) acc[pin.entity_type] = []
      acc[pin.entity_type].push(pin)
      return acc
    },
    {} as Record<PinEntityType, DrawingPin[]>
  )

  // Handle delete
  const handleDelete = async () => {
    if (!deletePin || !onPinDelete) return
    setIsDeleting(true)
    try {
      await onPinDelete(deletePin.id)
    } finally {
      setIsDeleting(false)
      setDeletePin(null)
    }
  }

  // Toggle filter
  const toggleTypeFilter = (type: PinEntityType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }

  const toggleStatusFilter = (status: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }

  const clearFilters = () => {
    setSelectedTypes(new Set())
    setSelectedStatuses(new Set())
  }

  const hasActiveFilters = selectedTypes.size > 0 || selectedStatuses.size > 0

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Linked Items</span>
          <Badge variant="secondary" className="text-xs">
            {filteredPins.length}
          </Badge>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={hasActiveFilters ? "secondary" : "ghost"} size="icon">
              <Filter className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Filter by Type</DropdownMenuLabel>
            {entityTypes.map((type) => (
              <DropdownMenuCheckboxItem
                key={type}
                checked={selectedTypes.has(type)}
                onCheckedChange={() => toggleTypeFilter(type)}
              >
                {PIN_ENTITY_TYPE_LABELS[type]}
              </DropdownMenuCheckboxItem>
            ))}

            {statuses.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                {statuses.map((status) => (
                  <DropdownMenuCheckboxItem
                    key={status}
                    checked={selectedStatuses.has(status)}
                    onCheckedChange={() => toggleStatusFilter(status)}
                  >
                    <span className="capitalize">{status.replace("_", " ")}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}

            {hasActiveFilters && (
              <>
                <DropdownMenuSeparator />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Pins list */}
      <ScrollArea className="flex-1">
        {filteredPins.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {pins.length === 0
              ? "No items linked to this drawing"
              : "No items match the current filters"}
          </div>
        ) : (
          <div className="p-2 space-y-4">
            {Object.entries(groupedPins).map(([type, typePins]) => {
              const Icon = ENTITY_ICONS[type as PinEntityType]
              return (
                <div key={type}>
                  <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
                    <Icon className="h-3.5 w-3.5" />
                    {PIN_ENTITY_TYPE_LABELS[type as PinEntityType]} ({typePins.length})
                  </div>
                  <div className="space-y-1">
                    {typePins.map((pin) => (
                      <div
                        key={pin.id}
                        className="group flex items-center gap-2 p-2 rounded-md hover:bg-muted transition-colors cursor-pointer"
                        onClick={() => onPinClick?.(pin)}
                      >
                        {/* Status indicator */}
                        <div
                          className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0",
                            pin.status
                              ? STATUS_COLORS[pin.status] || "bg-gray-400"
                              : "bg-gray-400"
                          )}
                        />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {pin.entity_title ?? pin.label ?? "Untitled"}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {pin.status && (
                              <span className="capitalize">
                                {pin.status.replace("_", " ")}
                              </span>
                            )}
                            <span>
                              ({Math.round(pin.x_position * 100)}%, {Math.round(pin.y_position * 100)}%)
                            </span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {onNavigateToEntity && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.stopPropagation()
                                onNavigateToEntity(pin)
                              }}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {onPinDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={(e) => {
                                e.stopPropagation()
                                setDeletePin(pin)
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Delete confirmation */}
      <AlertDialog open={!!deletePin} onOpenChange={() => setDeletePin(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove pin from drawing?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the link between this drawing and the{" "}
              {deletePin && PIN_ENTITY_TYPE_LABELS[deletePin.entity_type].toLowerCase()}.
              The item itself will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Removing..." : "Remove Pin"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
