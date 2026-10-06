export default function TakeoffArticle() {
  return (
    <>
      <p>
        Takeoff turns published drawing information into a reviewable quantity record. It lives in the drawing
        viewer, so measurements remain connected to the sheet and condition they came from instead of becoming
        an untraceable spreadsheet total.
      </p>

      <h2>Start from a published drawing</h2>
      <p>
        Open a project drawing and select <strong>Takeoff</strong>. Create or select a condition for the work
        you are measuring, then choose the appropriate measurement tool. A condition combines the cost code,
        unit of measure, and pricing inputs that make the quantity useful downstream.
      </p>

      <h2>Measure, review, and price</h2>
      <ol>
        <li>Confirm the sheet scale before recording a linear, area, or count measurement.</li>
        <li>Measure the relevant geometry on the sheet and save it to the selected condition.</li>
        <li>Review the condition rollup, including quantities on each sheet and the effective total.</li>
        <li>Check the cost-code pricing before using the total in an estimate, budget, or plan workflow.</li>
      </ol>
      <p>
        Quick Measure is a visual ruler. Takeoff measurements are the saved, condition-linked quantities that
        can be reviewed and synchronized; do not confuse the two.
      </p>

      <h2>Use templates for repeatable conditions</h2>
      <p>
        If your team measures the same scope repeatedly, maintain condition templates in
        <strong> Settings → Takeoff</strong>. Templates save the cost-code and measurement setup so estimators
        do not recreate standard assumptions project by project. Review the template before applying it—templates
        accelerate a known setup but do not replace sheet-specific judgment.
      </p>

      <h2>When drawings change</h2>
      <p>
        A new drawing revision can affect existing measurements. Review the revision and the takeoff alerts before
        accepting a changed quantity or synchronizing it. Re-anchor or remeasure where necessary, then review the
        delta and its destination. This is how Arc keeps an estimate or plan takeoff tied to the drawing revision
        that supports it.
      </p>

      <blockquote>
        Takeoff data is only as trustworthy as its scale, condition, and drawing revision. Resolve those three
        questions before treating a rollup as a cost commitment.
      </blockquote>
    </>
  )
}
