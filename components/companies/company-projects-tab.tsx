"use client"

import Link from "next/link"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export function CompanyProjectsTab({ projects }: { projects: { id: string; name: string }[] }) {
  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="divide-x">
            <TableHead className="px-4 py-3">Project</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow
              key={project.id}
              className="divide-x align-top hover:bg-muted/40 cursor-pointer"
              onClick={() => {
                window.location.href = `/projects/${project.id}`
              }}
            >
              <TableCell className="font-medium px-4 py-3">
                <Link href={`/projects/${project.id}`} className="hover:text-primary" onClick={(e) => e.stopPropagation()}>
                  {project.name}
                </Link>
              </TableCell>
            </TableRow>
          ))}
          {projects.length === 0 && (
            <TableRow className="divide-x">
              <TableCell colSpan={1} className="text-center text-muted-foreground py-10">
                No project history yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
