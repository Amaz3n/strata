import Link from "next/link"

export default function DailyLogsArticle() {
  return (
    <>
      <p>
        Daily Logs establish a dated, legal record of all activity and conditions on your jobsite. 
        Field teams can log weather conditions, internal and subcontractor labor hours, safety incidents, 
        material deliveries, visitors, and general progress.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Daily Summaries:</strong> Write an overall status report of the day&apos;s events and highlights.</li>
        <li><strong>Weather Tracking:</strong> Record daily weather conditions, temperature, and notes.</li>
        <li><strong>Subcontractor &amp; Labor Logs:</strong> Log companies on-site, crew sizes, labor hours, and specific trades (e.g., electrical, plumbing).</li>
        <li><strong>Quality &amp; Inspections:</strong> Document field inspection results and mark items as passed or failed.</li>
        <li><strong>Workflow Integration:</strong> Link log entries directly to schedule items, active tasks, punch items, or project cost codes.</li>
      </ul>

      <h2>Creating a Daily Log</h2>
      <p>
        Navigate to the <strong>Daily Logs</strong> section of your project. Select the calendar day you want to record, 
        and click <strong>Start Daily Log</strong>. You can enter an overall summary, save local weather conditions, 
        and start adding entries.
      </p>

      <h2>Adding Daily Log Entries</h2>
      <p>
        A single daily log can contain multiple entries divided into distinct categories:
      </p>
      
      <h3>Labor logs</h3>
      <p>
        Track the manpower on your site. For each subcontractor or internal crew:
      </p>
      <ul>
        <li>Select the company and specify the trade (e.g., <code>Framing</code>).</li>
        <li>Input the number of workers on-site (quantity) and the total hours worked.</li>
        <li>Link the entry to a specific project <strong>cost code</strong> to sync labor tracking with your budget actuals.</li>
      </ul>

      <h3>Inspections and safety</h3>
      <p>
        Log structural, electrical, or municipal inspections. Record the inspector&apos;s name, 
        the area inspected, and the official result (e.g., <strong>Passed</strong> or <strong>Failed</strong>). 
        You can also log safety talks or incident details.
      </p>

      <h3>Notes and references</h3>
      <p>
        Add notes for miscellaneous activities, visitor arrivals, material deliveries, or equipment usage. 
        You can tag an entry to a specific <strong>Task</strong>, <strong>Punch Item</strong>, or <strong>Schedule Item</strong> 
        to indicate that progress was made on that specific workflow.
      </p>

      <blockquote>
        <strong>Tip:</strong> Maintaining detailed logs is your best defense against project disputes. Encourage 
        superintendents to write entries and upload site photos as work occurs during the day.
      </blockquote>
    </>
  )
}
