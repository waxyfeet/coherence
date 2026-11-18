import { lazy, Suspense } from "react";
import type { SolutionGraph, GraphNodeKind } from "../shared/types";
const GraphCanvas = lazy(() => import("./graph/GraphCanvas"));
export function RealGraph(props: {
  graph: SolutionGraph;
  onCase: (id: string) => void;
  onScreen: (id: string) => void;
  onProposeChange: (kind: GraphNodeKind, id: string, label: string) => void;
}) {
  return (
    <Suspense
      fallback={
        <div className="real-loading">Opening the knowledge graph…</div>
      }
    >
      <GraphCanvas {...props} />
    </Suspense>
  );
}
