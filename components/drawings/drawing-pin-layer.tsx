'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Wrench,
  HelpCircle,
  AlertCircle,
  FileCheck,
  ClipboardList,
  Eye,
  AlertTriangle,
} from 'lucide-react'
import type { DrawingPin } from '@/lib/services/drawing-markups'
import type { PinEntityType, PinStatus } from '@/lib/validation/drawings'

interface DrawingPinLayerProps {
  pins: DrawingPin[]
  zoom: number
  containerWidth: number
  containerHeight: number
  onPinClick: (pin: DrawingPin) => void
  onClusterClick: (pins: DrawingPin[], center: { x: number; y: number }) => void
  highlightedPinId?: string | null
  clusterThreshold?: number // Minimum zoom to start clustering
  clusterRadius?: number // Pixel radius for clustering
}

interface Cluster {
  id: string
  pins: DrawingPin[]
  x: number // Average x position (0-1)
  y: number // Average y position (0-1)
}

const STATUS_COLORS: Record<PinStatus, string> = {
  open: 'bg-red-500 border-red-600',
  pending: 'bg-orange-500 border-orange-600',
  in_progress: 'bg-yellow-500 border-yellow-600',
  approved: 'bg-green-500 border-green-600',
  closed: 'bg-gray-500 border-gray-600',
  rejected: 'bg-purple-500 border-purple-600',
}

const STATUS_TEXT_COLORS: Record<PinStatus, string> = {
  open: 'text-red-500',
  pending: 'text-orange-500',
  in_progress: 'text-yellow-500',
  approved: 'text-green-500',
  closed: 'text-gray-500',
  rejected: 'text-purple-500',
}

const STATUS_RING_COLORS: Record<PinStatus, string> = {
  open: 'ring-red-500',
  pending: 'ring-orange-500',
  in_progress: 'ring-yellow-500',
  approved: 'ring-green-500',
  closed: 'ring-gray-500',
  rejected: 'ring-purple-500',
}

const ENTITY_ICONS: Record<PinEntityType, typeof Wrench> = {
  task: Wrench,
  rfi: HelpCircle,
  punch_list: AlertCircle,
  submittal: FileCheck,
  daily_log: ClipboardList,
  observation: Eye,
  issue: AlertTriangle,
}

const ENTITY_LABELS: Record<PinEntityType, string> = {
  task: 'Task',
  rfi: 'RFI',
  punch_list: 'Punch Item',
  submittal: 'Submittal',
  daily_log: 'Daily Log',
  observation: 'Observation',
  issue: 'Issue',
}

const STATUS_LABELS: Record<PinStatus, string> = {
  open: 'Open',
  pending: 'Pending',
  in_progress: 'In Progress',
  approved: 'Approved',
  closed: 'Closed',
  rejected: 'Rejected',
}

function clusterPins(
  pins: DrawingPin[],
  radius: number,
  containerWidth: number,
  containerHeight: number
): Cluster[] {
  if (pins.length === 0) return []

  const clusters: Cluster[] = []
  const assigned = new Set<string>()

  // Convert radius to normalized coordinates
  const radiusX = radius / containerWidth
  const radiusY = radius / containerHeight

  for (const pin of pins) {
    if (assigned.has(pin.id)) continue

    // Find all pins within radius
    const nearby: DrawingPin[] = [pin]
    assigned.add(pin.id)

    for (const other of pins) {
      if (assigned.has(other.id)) continue

      const dx = Math.abs(pin.x_position - other.x_position)
      const dy = Math.abs(pin.y_position - other.y_position)

      if (dx <= radiusX && dy <= radiusY) {
        nearby.push(other)
        assigned.add(other.id)
      }
    }

    // Calculate cluster center
    const avgX = nearby.reduce((sum, p) => sum + p.x_position, 0) / nearby.length
    const avgY = nearby.reduce((sum, p) => sum + p.y_position, 0) / nearby.length

    clusters.push({
      id: `cluster-${pin.id}`,
      pins: nearby,
      x: avgX,
      y: avgY,
    })
  }

  return clusters
}

export function DrawingPinLayer({
  pins,
  zoom,
  containerWidth,
  containerHeight,
  onPinClick,
  onClusterClick,
  highlightedPinId,
  clusterThreshold = 0.5,
  clusterRadius = 40,
}: DrawingPinLayerProps) {
  const shouldCluster = zoom < clusterThreshold

  const clusters = useMemo(() => {
    if (!shouldCluster) return null
    return clusterPins(pins, clusterRadius, containerWidth, containerHeight)
  }, [pins, shouldCluster, clusterRadius, containerWidth, containerHeight])

  if (shouldCluster && clusters) {
    return (
      <div className="absolute inset-0 pointer-events-none">
        {clusters.map(cluster => (
          <ClusterMarker
            key={cluster.id}
            cluster={cluster}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            onClick={() => onClusterClick(cluster.pins, { x: cluster.x, y: cluster.y })}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      {pins.map(pin => (
        <PinMarker
          key={pin.id}
          pin={pin}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          onClick={() => onPinClick(pin)}
          isHighlighted={pin.id === highlightedPinId}
        />
      ))}
    </div>
  )
}

interface PinMarkerProps {
  pin: DrawingPin
  containerWidth: number
  containerHeight: number
  onClick: () => void
  isHighlighted?: boolean
}

function PinMarker({ pin, containerWidth, containerHeight, onClick, isHighlighted }: PinMarkerProps) {
  const Icon = ENTITY_ICONS[pin.entity_type] || Wrench
  const status = pin.status || 'open'
  const statusColor = STATUS_COLORS[status]
  const statusTextColor = STATUS_TEXT_COLORS[status]
  const ringColor = STATUS_RING_COLORS[status]

  const left = pin.x_position * containerWidth
  const top = pin.y_position * containerHeight

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'absolute pointer-events-auto transform -translate-x-1/2 -translate-y-full',
            'flex flex-col items-center transition-transform hover:scale-110',
            isHighlighted && 'scale-125 z-10'
          )}
          style={{ left, top }}
        >
          {/* Pin head */}
          <div className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md border-2 shadow-md',
            statusColor,
            'text-white text-xs font-medium',
            isHighlighted && `ring-2 ring-offset-2 ${ringColor}`
          )}>
            <Icon className="h-3 w-3" />
            {pin.label && <span className="max-w-20 truncate">{pin.label}</span>}
          </div>

          {/* Pin tail */}
          <div className="w-0 h-0 border-l-4 border-r-4 border-t-8 border-l-transparent border-r-transparent border-t-current"
            style={{ color: status === 'open' ? '#EF4444' : status === 'pending' ? '#F97316' : status === 'in_progress' ? '#EAB308' : status === 'approved' ? '#22C55E' : status === 'rejected' ? '#8B5CF6' : '#6B7280' }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-sm">
          <div className="font-medium">{ENTITY_LABELS[pin.entity_type]}</div>
          {pin.label && (
            <div className="text-muted-foreground">{pin.label}</div>
          )}
          <div className={cn('text-xs capitalize', statusTextColor)}>
            {STATUS_LABELS[status]}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

interface ClusterMarkerProps {
  cluster: Cluster
  containerWidth: number
  containerHeight: number
  onClick: () => void
}

function ClusterMarker({ cluster, containerWidth, containerHeight, onClick }: ClusterMarkerProps) {
  const left = cluster.x * containerWidth
  const top = cluster.y * containerHeight

  // Determine cluster color based on highest priority status
  const hasOpen = cluster.pins.some(p => (p.status || 'open') === 'open')
  const hasInProgress = cluster.pins.some(p => p.status === 'in_progress')
  const hasPending = cluster.pins.some(p => p.status === 'pending')

  let bgColor = 'bg-gray-500'
  if (hasOpen) bgColor = 'bg-red-500'
  else if (hasPending) bgColor = 'bg-orange-500'
  else if (hasInProgress) bgColor = 'bg-yellow-500'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'absolute pointer-events-auto transform -translate-x-1/2 -translate-y-1/2',
            'transition-transform hover:scale-110'
          )}
          style={{ left, top }}
        >
          <div className={cn(
            'w-10 h-10 rounded-full flex items-center justify-center',
            'text-white font-bold text-sm shadow-lg border-2 border-white',
            bgColor
          )}>
            {cluster.pins.length}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-sm">
          <div className="font-medium">{cluster.pins.length} items</div>
          <div className="text-muted-foreground text-xs">Click to zoom in</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
