import { AbsoluteFill, Sequence } from "remotion";
import { Scene } from "../../kit/canvas";
import { Approve, DraftsFill, DropFiles, EndCard, Hook, ReadInvoice, SidebarZoom } from "./scenes";

// Each shot overlaps the next by OVERLAP frames so the blur-fade of one runs
// under the entrance of the next.
const OVERLAP = 10;
const SHOTS = [
  { name: "Hook", length: 80, Shot: Hook },
  { name: "Sidebar", length: 100, Shot: SidebarZoom },
  { name: "Drop", length: 110, Shot: DropFiles },
  { name: "Read", length: 185, Shot: ReadInvoice },
  { name: "Drafts", length: 150, Shot: DraftsFill },
  { name: "Approve", length: 175, Shot: Approve },
  { name: "End", length: 100, Shot: EndCard },
];

export const PAYABLES_DURATION = SHOTS.reduce((sum, s) => sum + s.length, 0) - OVERLAP * (SHOTS.length - 1);

export function PayablesVideo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: "black" }}>
      {SHOTS.map(({ name, length, Shot }, i) => {
        const start = from;
        from += length - OVERLAP;
        return (
          <Sequence key={name} name={name} from={start} durationInFrames={length}>
            <Scene duration={length} inFrames={i === 0 ? 0 : OVERLAP} outFrames={i === SHOTS.length - 1 ? 0 : OVERLAP}>
              <Shot />
            </Scene>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
