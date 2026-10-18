const { PDFDocument, StandardFonts } = require("pdf-lib");
async function syntheticPdf(
  pages,
  { changedPage = -1, reordered = false } = {},
) {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2020-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2020-01-01T00:00:00Z"));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const identity = reordered ? pages - index : index + 1;
    const page = pdf.addPage([600, 400]);
    page.drawText(`SHEET NUMBER: A${identity}`, {
      x: 430,
      y: 25,
      size: 10,
      font,
    });
    page.drawText(`TITLE: FLOOR PLAN ${identity}`, {
      x: 400,
      y: 45,
      size: 10,
      font,
    });
    page.drawRectangle({
      x: 40,
      y: 80,
      width: 300 + (identity === changedPage ? 10 : 0),
      height: 250,
      borderWidth: 1,
    });
  }
  return Buffer.from(await pdf.save());
}
module.exports = { syntheticPdf };
