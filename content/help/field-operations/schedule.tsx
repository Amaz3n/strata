import Link from "next/link"

export default function ScheduleArticle() {
  return (
    <>
      <p>
        The Schedule tool in Arc allows you to build, maintain, and track your project timeline. 
        It supports critical path scheduling, milestones, dependencies, baselines, and scheduling templates 
        to ensure your project finishes on time and on budget.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Schedule Items:</strong> Define tasks and milestones with start dates, end dates, durations, and colors.</li>
        <li><strong>Dependencies &amp; Lag:</strong> Link tasks together using Finish-to-Start (FS), Start-to-Start (SS), Finish-to-Finish (FF), or Start-to-Finish (SF) relationships, including lag days.</li>
        <li><strong>Critical Path &amp; Float:</strong> Automatically calculate your critical path to highlight tasks that dictate the project end date and identify tasks with float days.</li>
        <li><strong>Baselines:</strong> Take snapshots of your schedule before construction starts to compare actual progress against original targets.</li>
        <li><strong>Cost &amp; Hours Tracking:</strong> Link schedule items to cost codes to log planned vs. actual hours and track budgeting details.</li>
        <li><strong>Templates:</strong> Save schedules as templates to easily initialize timelines for future projects.</li>
      </ul>

      <h2>Creating Schedule Items</h2>
      <p>
        Navigate to the <strong>Schedule</strong> page under your project to view the timeline. You can toggle between 
        Gantt, list, and calendar views. Click <strong>Add Schedule Item</strong> to create a new task or milestone.
      </p>
      <ul>
        <li><strong>Item Type:</strong> Choose <strong>Task</strong> for work items with duration, or <strong>Milestone</strong> for key project events (zero-day duration).</li>
        <li><strong>Constraint Type:</strong> Select how the item dates are determined. By default, items are scheduled <strong>As Soon As Possible (ASAP)</strong> based on dependencies. Other constraints include <em>Must Start On</em>, <em>Start No Earlier Than</em>, etc.</li>
        <li><strong>Assigned To:</strong> Assign the task to a team member or subcontractor contact.</li>
        <li><strong>Color Coding:</strong> Assign custom colors to categorize tasks visually on the Gantt chart.</li>
      </ul>

      <h2>Managing Dependencies</h2>
      <p>
        To link tasks, select a schedule item and open the <strong>Dependencies</strong> tab, or drag connection lines 
        directly between Gantt bars. 
      </p>
      <blockquote>
        <strong>Tip:</strong> If a predecessor task is delayed, Arc automatically shifts all dependent successor tasks 
        according to the constraint rules and relationship types, keeping your schedule dynamic and up to date.
      </blockquote>

      <h2>Baselines and Performance Comparison</h2>
      <p>
        Before mobilizing on-site, navigate to the schedule settings and click <strong>Save Baseline</strong>. 
        This captures a static snapshot of your planned dates. As work progresses, you can turn on the 
        <strong>Baseline Overlay</strong> to visually compare your actual timeline against your original commitments.
      </p>

      <h2>Cross-Project Tracking</h2>
      <p>
        If you manage multiple jobs, navigate to the workspace-level <strong>Schedule Control</strong>. 
        This screen compiles schedule summaries from all active projects into a single master dashboard, 
        making it easy to identify resource conflicts or schedule overruns across your company.
      </p>
    </>
  )
}
