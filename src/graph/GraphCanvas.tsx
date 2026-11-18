import { useMemo, useState } from "react";
import { isLightTheme, useTheme } from "../themes/useTheme";
import { isOdysseusTheme } from "../themes/odysseus";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import {
  ArrowRight,
  FileText,
  Filter,
  Image,
  Network,
  Search,
} from "lucide-react";
import type { GraphNodeKind, SolutionGraph } from "../../shared/types";
import { Badge, Button, SectionHeading } from "../ui";
import "@xyflow/react/dist/style.css";
type EvidenceNode = Node<
  { label: string; kind: GraphNodeKind; domainId: string },
  "evidence"
>;
const kinds: GraphNodeKind[] = [
  "screen",
  "region",
  "element",
  "usecase",
  "rule",
  "scenario",
  "persona",
  "feature",
];
function EvidenceNodeView({ data, selected }: NodeProps<EvidenceNode>) {
  return (
    <div
      className={`evidence-graph-node ${data.kind} ${selected ? "selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div>
        <span className="small-dot" />
        <small>{data.kind === "usecase" ? data.domainId : data.kind}</small>
      </div>
      <strong>{data.label}</strong>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { evidence: EvidenceNodeView };
export default function GraphCanvas({
  graph,
  onCase,
  onScreen,
  onProposeChange,
}: {
  graph: SolutionGraph;
  onCase: (id: string) => void;
  onScreen: (id: string) => void;
  onProposeChange: (kind: GraphNodeKind, id: string, label: string) => void;
}) {
  const theme = useTheme();
  const ported = isOdysseusTheme(theme);
  const [visible, setVisible] = useState<GraphNodeKind[]>([
    "screen",
    "usecase",
    "feature",
  ]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [listView, setListView] = useState(false);
  const [neighborFocus, setNeighborFocus] = useState(false);
  const selected = graph.nodes.find((n) => n.id === selectedId);
  const related = graph.edges.filter(
    (e) => e.from === selectedId || e.to === selectedId,
  );
  const { nodes, edges } = useMemo(() => {
    const neighbors = new Set([
      selectedId,
      ...related.flatMap((e) => [e.from, e.to]),
    ]);
    const filtered = graph.nodes.filter(
      (n) =>
        visible.includes(n.kind) &&
        (!neighborFocus || neighbors.has(n.id)) &&
        (!search ||
          (n.id + " " + n.label).toLowerCase().includes(search.toLowerCase())),
    );
    const ids = new Set(filtered.map((n) => n.id));
    const edges = graph.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.kind.replaceAll("_", " "),
        animated: false,
        style: {
          stroke: ported
            ? e.kind === "depends_on"
              ? "var(--accent)"
              : "var(--graph-edge)"
            : e.kind === "depends_on"
              ? "#c58b68"
              : "#596272",
          strokeWidth: 1.2,
        },
        labelStyle: { fill: ported ? "var(--fg)" : "#8f99a8", fontSize: 10 },
        labelBgStyle: { fill: ported ? "var(--panel)" : "#1d222b" },
        markerEnd: {
          type: "arrowclosed" as const,
          color: ported ? "var(--graph-edge)" : "#798595",
        },
      }));
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({
      rankdir: "LR",
      nodesep: 34,
      ranksep: 90,
      marginx: 30,
      marginy: 30,
    });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const n of filtered) layout.setNode(n.id, { width: 218, height: 82 });
    for (const e of edges) layout.setEdge(e.source, e.target);
    dagre.layout(layout);
    const nodes: EvidenceNode[] = filtered.map((n) => {
      const pos = layout.node(n.id);
      return {
        id: n.id,
        type: "evidence",
        position: { x: pos.x - 109, y: pos.y - 41 },
        data: { label: n.label, kind: n.kind, domainId: n.id },
        selected: n.id === selectedId,
      };
    });
    return { nodes, edges };
  }, [graph, visible, search, selectedId, neighborFocus, ported]);
  return (
    <div className="workspace-page real-graph-page">
      <SectionHeading
        eyebrow="EVERYTHING IS CONNECTED"
        title="Knowledge graph"
        description={`${graph.nodes.length} evidence nodes · ${graph.edges.length} typed relationships. Explore how your specification fits together.`}
      />
      <div className="real-graph-workbench">
        <div className="graph-canvas-wrap">
          <div className="real-graph-filter">
            <Search size={14} />
            <input
              aria-label="Search graph nodes"
              placeholder="Find a node…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Filter size={13} />
            <button
              aria-pressed={listView}
              onClick={() => setListView((v) => !v)}
            >
              {listView ? "Canvas" : "List view"}
            </button>
            {kinds.map((kind) => (
              <button
                key={kind}
                aria-pressed={visible.includes(kind)}
                className={visible.includes(kind) ? "active" : ""}
                onClick={() =>
                  setVisible((v) =>
                    v.includes(kind)
                      ? v.filter((k) => k !== kind)
                      : [...v, kind],
                  )
                }
              >
                {kind}
              </button>
            ))}
          </div>
          {listView ? (
            <div
              className="graph-accessible-list"
              aria-label="Knowledge graph evidence list"
            >
              {nodes.map((node) => (
                <button
                  key={node.id}
                  aria-pressed={selectedId === node.id}
                  onClick={() => setSelectedId(node.id)}
                >
                  <Badge>{node.data.kind}</Badge>
                  <span>
                    {node.data.label}
                    <small>{node.id}</small>
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          ) : graph.nodes.length ? (
            <ReactFlow
              key={
                visible.join(",") + search + (neighborFocus ? selectedId : "")
              }
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              fitView
              fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
              minZoom={0.08}
              maxZoom={2}
              nodesConnectable={false}
              colorMode={isLightTheme(theme) ? "light" : "dark"}
              ariaLabelConfig={{
                "controls.zoomIn.ariaLabel": "Zoom into knowledge graph",
                "controls.zoomOut.ariaLabel": "Zoom out of knowledge graph",
                "controls.fitView.ariaLabel": "Fit knowledge graph to view",
              }}
            >
              <Background
                color={ported ? "var(--border)" : "#535e7040"}
                gap={22}
                size={1}
              />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) =>
                  ported
                    ? n.data.kind === "usecase"
                      ? "var(--accent)"
                      : "var(--fg)"
                    : n.data.kind === "usecase"
                      ? "#b98b70"
                      : "#697e91"
                }
                maskColor="rgba(17,21,28,.5)"
              />
            </ReactFlow>
          ) : (
            <div className="real-loading">
              <Network size={32} />
              <p>
                Generate specifications to connect screens, elements and use
                cases.
              </p>
            </div>
          )}
        </div>
        <aside className="graph-real-details">
          <div className="pane-label">
            <span>TRACEABILITY</span>
            <Network size={14} />
          </div>
          <div className="inspector-section">
            {selected ? (
              <>
                <Badge tone="accent">{selected.kind}</Badge>
                <h3>{selected.label}</h3>
                <code>{selected.id}</code>
                <Button
                  compact
                  aria-pressed={neighborFocus}
                  onClick={() => {
                    setNeighborFocus((v) => !v);
                    setVisible(kinds);
                    setSearch("");
                  }}
                >
                  {neighborFocus ? "Show whole graph" : "Focus neighbors"}
                </Button>
                <Button
                  compact
                  onClick={() =>
                    onProposeChange(selected.kind, selected.id, selected.label)
                  }
                >
                  Propose a change
                  <ArrowRight size={12} />
                </Button>
                {selected.kind === "usecase" && (
                  <Button compact onClick={() => onCase(selected.id)}>
                    <FileText size={13} />
                    Open use case
                    <ArrowRight size={12} />
                  </Button>
                )}
                {selected.kind === "screen" && (
                  <Button compact onClick={() => onScreen(selected.id)}>
                    <Image size={13} />
                    Open screenshot
                  </Button>
                )}
                <h4>Connected evidence</h4>
                {related.map((e) => {
                  const other = graph.nodes.find(
                    (n) => n.id === (e.from === selectedId ? e.to : e.from),
                  );
                  return (
                    <button
                      className="graph-related"
                      key={e.id}
                      onClick={() => other && setSelectedId(other.id)}
                    >
                      <small>{e.kind.replaceAll("_", " ")}</small>
                      <strong>{other?.label ?? "Unknown node"}</strong>
                      <span>{other?.kind}</span>
                    </button>
                  );
                })}
              </>
            ) : (
              <>
                <h3>The shape of understanding.</h3>
                <p>
                  Choose a node to inspect its evidence and connections. Pan and
                  zoom the canvas, or reveal all eight node types in the
                  toolbar.
                </p>
                <div className="overview-stat-list">
                  {kinds.map((kind) => (
                    <span key={kind}>
                      {kind}
                      <strong>
                        {graph.nodes.filter((n) => n.kind === kind).length}
                      </strong>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
