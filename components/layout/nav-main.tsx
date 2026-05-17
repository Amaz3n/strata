"use client"

import * as React from "react"
import { ChevronRight, type LucideIcon } from "lucide-react"

import { OptimisticLink, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

type NavSubItem = {
  title: string
  url: string
  isActive?: boolean
}

type NavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: number
  disabled?: boolean
  items?: NavSubItem[]
}

type NavGroup = {
  label?: string
  items: NavItem[]
}

const activeItemClass =
  "data-[active=true]:shadow-[inset_2px_0_0_0_var(--sidebar-primary)] data-[active=true]:text-sidebar-foreground"

const activeSubItemClass = [
  "data-[active=true]:bg-[oklch(0.58_0.20_264_/_0.4)]",
  "data-[active=true]:hover:bg-[oklch(0.58_0.20_264_/_0.5)]",
  "data-[active=true]:text-sidebar-foreground",
  "data-[active=true]:font-semibold",
  "data-[active=true]:shadow-[inset_3px_0_0_0_var(--sidebar-primary)]",
].join(" ")

export function NavMain({ items }: { items: NavGroup[] }) {
  const pathname = useOptimisticPathname()

  const [currentPath, setCurrentPath] = React.useState(pathname)
  React.useEffect(() => {
    try {
      const searchParams = new URLSearchParams(window.location.search)
      const query = searchParams.toString()
      setCurrentPath(query ? `${pathname}?${query}` : pathname)
    } catch {
      setCurrentPath(pathname)
    }
  }, [pathname])

  if (!items.length || items.every((group) => group.items.length === 0)) return null

  return (
    <>
      {items.map((group, groupIndex) => (
        <SidebarGroup
          key={group.label ?? `group-${groupIndex}`}
          className={groupIndex > 0 ? "pt-1" : undefined}
        >
          {group.label ? (
            <SidebarGroupLabel className="px-2 text-[11px] tracking-[0.08em] uppercase text-sidebar-foreground/45">
              {group.label}
            </SidebarGroupLabel>
          ) : null}
          <SidebarMenu>
            {group.items.map((item) => {
              const subActive = item.items?.some((s) => s.isActive) ?? false

              return (
                <Collapsible
                  key={item.title}
                  asChild
                  defaultOpen={subActive}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    {item.items?.length ? (
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton tooltip={item.title}>
                          {item.icon && <item.icon />}
                          <span>{item.title}</span>
                          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                    ) : (
                      <>
                        {item.disabled ? (
                          <SidebarMenuButton
                            tooltip={item.title}
                            isActive={false}
                            aria-disabled="true"
                          >
                            {item.icon && <item.icon />}
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                        ) : (
                          <SidebarMenuButton
                            tooltip={item.title}
                            isActive={item.isActive}
                            asChild
                            className={activeItemClass}
                          >
                            <OptimisticLink href={item.url}>
                              {item.icon && <item.icon />}
                              <span>{item.title}</span>
                            </OptimisticLink>
                          </SidebarMenuButton>
                        )}
                        {item.badge !== undefined && item.badge > 0 && !item.disabled && (
                          <SidebarMenuBadge className="bg-red-500 text-white">
                            {item.badge > 99 ? "99+" : item.badge}
                          </SidebarMenuBadge>
                        )}
                      </>
                    )}
                    {item.items?.length ? (
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.items.map((subItem) => {
                            const isSubActive =
                              subItem.isActive ??
                              (currentPath === subItem.url || pathname === subItem.url)
                            return (
                              <SidebarMenuSubItem key={subItem.title}>
                                <SidebarMenuSubButton
                                  asChild
                                  isActive={isSubActive}
                                  className={activeSubItemClass}
                                >
                                  <OptimisticLink href={subItem.url}>
                                    <span>{subItem.title}</span>
                                  </OptimisticLink>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            )
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    ) : null}
                  </SidebarMenuItem>
                </Collapsible>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  )
}
