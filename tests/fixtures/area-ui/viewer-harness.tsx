import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DrawingViewer } from "../../../components/drawings/drawing-viewer";
import type { DrawingSheet } from "../../../app/(app)/drawings/types";
const sheets = [1, 2].map((n) => ({
  id: `sheet-${n}`,
  sheet_number: `A-2.${n}`,
  sheet_title: "First floor plan",
  project_id: "project-test",
  discipline: "A",
  tile_base_url: `/tiles/${n}`,
  tile_manifest: {
    Image: {
      Size: { Width: 1000, Height: 1000 },
      TileSize: 256,
      Overlap: 0,
      Format: "jpg",
    },
  },
  image_width: 1000,
  image_height: 1000,
})) as unknown as DrawingSheet[];
function Harness() {
  const [sheet, setSheet] = useState(sheets[0]);
  return (
    <DrawingViewer
      measurementContext={
        new URLSearchParams(location.search).has("bound")
          ? {
              destination: "pricing_worksheet",
              targetId: "prospect-test",
              label: "Example estimate",
              returnHref: "/estimate",
              rowId: "row-test",
              rowLabel: "LVP Flooring",
              conditionId: "22222222-2222-4222-8222-222222222222",
            }
          : undefined
      }
      initialConditionId={
        new URLSearchParams(location.search).has("bound")
          ? "22222222-2222-4222-8222-222222222222"
          : undefined
      }
      sheet={sheet}
      sheets={sheets}
      onNavigateSheet={setSheet}
      fileUrl={undefined}
      takeoffProjectId="project-test"
      canWriteTakeoff
      modelTarget={{ kind: "project", projectId: "project-test" }}
      canWriteModel
      onClose={() => {
        Object.assign(window, { viewerClosed: true });
      }}
      onSaveMarkup={async () => {
        Object.assign(window, { manualSaved: true });
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
