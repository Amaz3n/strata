import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPreparation } from "../../../components/plans/model-preparation";
import { ModelInspector } from "../../../components/plans/model-inspector";
import { ModelStage } from "../../../components/plans/model-viewer/model-stage";
import { FloorplanReview } from "../../../components/plans/floorplan-review";
import {
  applyFloorplanEdit,
  type FloorplanModel,
} from "../../../lib/drawings/floorplan-model";
const ring: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, 15],
  [0, 15],
];
const initial: FloorplanModel = {
  version: 1,
  units: "feet",
  correctionCount: 0,
  warnings: ["Compare the scan against the source."],
  levels: [
    {
      reconstruction: {
        version: 1,
        status: "needs-review",
        source: {
          wallPathCount: 4,
          representedWallPathCount: 3,
          excludedPathCount: 0,
        },
        issues: [
          {
            id: "missing-face",
            code: "unpaired-wall",
            severity: "review",
            message: "Check this source wall span.",
            pathIds: [1],
            point: [0.2, 0.2],
          },
          {
            id: "paired-group",
            code: "competing-wall-body",
            severity: "review",
            message: "Two source intervals need review.",
            pathIds: [2],
            point: [0.2, 0.2],
            members: [
              {
                id: "first",
                message: "Check the first paired interval.",
                point: [0.2, 0.2],
              },
              {
                id: "second",
                message: "Check the second paired interval.",
                point: [0.4, 0.6],
              },
            ],
          },
        ],
      },
      id: "L0",
      name: "Ground floor",
      order: 0,
      ceilingHeightFt: 9,
      source: {
        sheetVersionId: "s",
        sheetNumber: null,
        sheetTitle: null,
        imageWidth: 1000,
        imageHeight: 750,
        feetPerImagePx: 0.02,
        originPxX: 0,
        originPxY: 0,
        scaleConfirmed: true,
      },
      walls: ring.map((p, i) => ({
        id: `w${i}`,
        x0: p[0],
        y0: p[1],
        x1: ring[(i + 1) % 4][0],
        y1: ring[(i + 1) % 4][1],
        thicknessFt: 0.5,
        confidence: 1,
        source: "manual",
      })),
      rooms: [
        {
          id: "r",
          polygon: ring,
          label: "Living",
          areaSqft: 300,
          confidence: 1,
        },
      ],
      openings: [
        {
          id: "window",
          wallId: "w0",
          kind: "window",
          offsetFt: 2,
          widthFt: 5.36,
          widthBasis: "connected-frame",
          sillFt: 3,
          headFt: 7,
          confidence: 0.7,
        },
      ],
      confidence: { walls: 1, rooms: 1, openings: 1 },
    },
  ],
};
function App() {
  const [model, setModel] = useState(initial),
    [selection, setSelection] = useState<string | null>(null);
  (window as any).model = model;
  const [preparing, setPreparing] = useState(false);
  const [reviewPlan, setReviewPlan] = useState(false);
  return (
    <>
      <button onClick={() => setPreparing(true)}>Prepare sources</button>
      <button onClick={() => setReviewPlan((p) => !p)}>
        Toggle floor plan test view
      </button>
      <ModelPreparation
        target={{
          kind: "project",
          projectId: "10000000-0000-0000-0000-000000000001",
        }}
        open={preparing}
        busy={false}
        onClose={() => setPreparing(false)}
        onGenerate={(sources) => {
          (window as any).sources = sources;
          setPreparing(false);
        }}
      />
      <div style={{ height: "100vh", display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {reviewPlan ? (
            <FloorplanReview
              level={model.levels[0]}
              sheet={null}
              editable
              saving={false}
              selection={selection}
              onSelect={setSelection}
              onEdit={(edit) => setModel((m) => applyFloorplanEdit(m, edit))}
            />
          ) : (
            <ModelStage
              model={model}
              title="Model studio verification"
              selected={selection}
              onSelect={(pick) => setSelection(pick?.id ?? null)}
              onSaveView={(view) =>
                setModel((m) =>
                  applyFloorplanEdit(m, {
                    type: "view.save",
                    levelId: "L0",
                    view,
                  }),
                )
              }
            />
          )}
        </div>
        <ModelInspector
          model={model}
          level={model.levels[0]}
          selection={selection}
          onSelect={setSelection}
          onEdit={(edit) => setModel((m) => applyFloorplanEdit(m, edit))}
          disabled={false}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
