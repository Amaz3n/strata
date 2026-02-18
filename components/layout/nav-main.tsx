"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight, type LucideIcon } from "lucide-react"

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

export function NavMain({
  items,
}: {
  items: {
    label?: string
    items: {
      title: string
      url: string
      icon?: LucideIcon
      isActive?: boolean
      badge?: number
      disabled?: boolean
      items?: {
        title: string
        url: string
      }[]
    }[]
  }[]
}) {
  const pathname = usePathname()

  // Avoid hydration issues with useSearchParams by only using it after hydration
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
        <SidebarGroup key={group.label ?? `group-${groupIndex}`}>
          {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
          <SidebarMenu>
            {group.items.map((item) => (
              <Collapsible
                key={item.title}
                asChild
                defaultOpen={item.isActive}
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
                        <SidebarMenuButton tooltip={item.title} isActive={item.isActive} asChild>
                          <Link href={item.url}>
                            {item.icon && <item.icon />}
                            <span>{item.title}</span>
                          </Link>
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
                        {item.items?.map((subItem) => (
                          <SidebarMenuSubItem key={subItem.title}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={currentPath === subItem.url || pathname === subItem.url}
                            >
                              <Link href={subItem.url}>
                                <span>{subItem.title}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  ) : null}
                </SidebarMenuItem>
              </Collapsible>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  )
}
