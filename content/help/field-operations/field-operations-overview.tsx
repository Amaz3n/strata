import Link from "next/link"

export default function FieldOperationsOverviewArticle() {
  return (
    <>
      <p>
        Field Operations provides the day-to-day tools used on active job sites to coordinate labor, track construction 
        progress, manage issues, and document client choices. Keeping active records in Arc ensures full visibility 
        between the field and the office.
      </p>

      <h2>Core Modules in Field Operations</h2>
      <p>
        Field Operations includes four integrated modules. Click the detailed guides below to learn how to manage 
        each workflow:
      </p>

      <h3>1. Schedule</h3>
      <p>
        Build Gantt charts, manage FS/SS/FF dependencies, track critical path float, and baseline your timeline to 
        compare planned vs. actual project completion.
        {" "}
        <Link href="/help/field-operations/field-workflows/schedule">
          Read the Schedule Guide
        </Link>
        .
      </p>

      <h3>2. Daily Logs</h3>
      <p>
        Record daily site conditions, weather stats, internal/subcontractor manpower, visitor logs, and inspections, 
        linking entries directly to cost codes and schedule items.
        {" "}
        <Link href="/help/field-operations/field-workflows/daily-logs">
          Read the Daily Logs Guide
        </Link>
        .
      </p>

      <h3>3. Punch</h3>
      <p>
        Log and verify construction defects and completion items. Assign items to trade subcontractors and let them 
        mark deficiencies resolved through secure portals.
        {" "}
        <Link href="/help/field-operations/field-workflows/punch">
          Read the Punch Guide
        </Link>
        .
      </p>

      <h3>4. Decisions</h3>
      <p>
        Track client and architect selections for finishes, colors, and fixtures, logging official approval dates 
        and options chosen to prevent delays.
        {" "}
        <Link href="/help/field-operations/field-workflows/decisions">
          Read the Decisions Guide
        </Link>
        .
      </p>
    </>
  )
}
