import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  NODES,
  EDGES,
  CLUSTERS,
} from "./knowledgeFixture";
import type {
  KnowledgeNode,
  KnowledgeEdge,
  KnowledgeCluster,
  InteractionState,
} from "./knowledgeTypes";
import {
  EVIDENCE_LABELS,
  PERMISSION_LABELS,
  NODE_TYPE_LABELS,
} from "./knowledgeTypes";
import "./knowledge.css";

/* ── State ──────────────────────────────────────────────────────── */

type State = {
  selectedId: string | null;
  focusedId: string | null;
  expandedClusterIds: Set<string>;
  hoveredId: string | null;
};

type Action =
  | { type: "select"; id: string | null }
  | { type: "focus"; id: string | null }
  | { type: "toggle-focused-cluster"; nodeId: string }
  | { type: "hover"; id: string | null }
  | { type: "return" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "select":
      return {
        ...state,
        selectedId: action.id,
        focusedId: null,
      };
    case "focus":
      return {
        ...state,
        selectedId: state.selectedId,
        focusedId: action.id,
      };
    case "toggle-focused-cluster": {
      if (state.focusedId !== action.nodeId) return state;
      const cluster = findClusterForNode(action.nodeId);
      if (!cluster) return state;

      const next = new Set(state.expandedClusterIds);
      if (next.has(cluster.id)) {
        next.delete(cluster.id);
      } else {
        next.add(cluster.id);
      }
      return { ...state, expandedClusterIds: next };
    }
    case "hover":
      return { ...state, hoveredId: action.id };
    case "return": {
      // Precedence: expanded → collapse only, focus → clear focus, selected → clear selected
      if (state.expandedClusterIds.size > 0) {
        const next = new Set(state.expandedClusterIds);
        const first = next.values().next().value!;
        next.delete(first);
        return { ...state, expandedClusterIds: next };
      }
      if (state.focusedId) {
        return { ...state, focusedId: null };
      }
      return { ...state, selectedId: null };
    }
    default:
      return state;
  }
}

const INITIAL_STATE: State = {
  selectedId: null,
  focusedId: null,
  expandedClusterIds: new Set(),
  hoveredId: null,
};

/* ── Helpers ────────────────────────────────────────────────────── */

function getInteractionState(
  nodeId: string,
  s: State,
): InteractionState {
  if (s.focusedId === nodeId) return "focused";
  if (s.selectedId === nodeId) return "selected";
  return "idle";
}

function getRelatedNodeIds(
  nodeId: string,
  edges: KnowledgeEdge[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.from === nodeId) ids.add(e.to);
    if (e.to === nodeId) ids.add(e.from);
  }
  return ids;
}

function getIndirectRelatedNodeIds(
  nodeId: string,
  directIds: Set<string>,
  edges: KnowledgeEdge[],
): Set<string> {
  const ids = new Set<string>();
  for (const id of directIds) {
    for (const e of edges) {
      const other = e.from === id ? e.to : e.to === id ? e.from : null;
      if (other && other !== nodeId && !directIds.has(other)) {
        ids.add(other);
      }
    }
  }
  return ids;
}

function findClusterForNode(nodeId: string): KnowledgeCluster | undefined {
  return CLUSTERS.find((c) => c.nodeIds.includes(nodeId));
}

const NODE_RADIUS = 24;
const TASK_SIZE = 39;
const CLUSTER_PADDING = 35;
const EDGE_LABEL_NORMAL_OFFSET = 56;

type GraphBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function getNodeBounds(nodes: KnowledgeNode[]): GraphBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }

  return { minX, minY, maxX, maxY };
}

function getEdgeEndpoints(from: KnowledgeNode, to: KnowledgeNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const unitX = dx / length;
  const unitY = dy / length;
  const inset = NODE_RADIUS + 3;

  return {
    x1: from.x + unitX * inset,
    y1: from.y + unitY * inset,
    x2: to.x - unitX * inset,
    y2: to.y - unitY * inset,
  };
}

function getEdgeLabelPosition(from: KnowledgeNode, to: KnowledgeNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;

  return {
    x: (from.x + to.x) / 2 + normalX * EDGE_LABEL_NORMAL_OFFSET,
    y: (from.y + to.y) / 2 + normalY * EDGE_LABEL_NORMAL_OFFSET,
  };
}

/* ── Props ──────────────────────────────────────────────────────── */

type PreviewState = "idle" | "loading" | "empty" | "degraded" | "unavailable" | "error";

type Props = {
  inspectingId: string | null;
  onInspectingChange: (id: string | null) => void;
  previewState?: PreviewState;
};

/* ── Component ──────────────────────────────────────────────────── */

export function KnowledgeConstellation({
  inspectingId,
  onInspectingChange,
  previewState = "idle",
}: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeRefs = useRef<Map<string, SVGElement>>(new Map());
  const [qaPreviewOverride, setQaPreviewOverride] = useState<PreviewState | null>(null);

  const effectivePreviewState = qaPreviewOverride ?? previewState;

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  /* Node adjacency maps */

  const directRelated = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of NODES) {
      map.set(n.id, getRelatedNodeIds(n.id, EDGES));
    }
    return map;
  }, []);

  const indirectRelated = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of NODES) {
      const direct = directRelated.get(n.id) ?? new Set();
      map.set(n.id, getIndirectRelatedNodeIds(n.id, direct, EDGES));
    }
    return map;
  }, [directRelated]);

  /* Expanded nodes: cluster nodes are visible only when their cluster is expanded */

  const visibleNodes = useMemo(() => {
    return NODES.filter((n) => {
      if (!n.clusterId) return true;
      return state.expandedClusterIds.has(n.clusterId);
    });
  }, [state.expandedClusterIds]);

  const visibleEdges = useMemo(() => {
    const nodeIds = new Set(visibleNodes.map((n) => n.id));
    return EDGES.filter(
      (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
    );
  }, [visibleNodes]);

  /* Cluster visibility: show outline only when NOT expanded */

  const visibleClusters = useMemo(() => {
    return CLUSTERS.filter((c) => !state.expandedClusterIds.has(c.id));
  }, [state.expandedClusterIds]);

  /* Collapsed clusters use compact presentation bounds. This keeps them intentional
     and fully framed without shrinking the readable graph to fit hidden-node geometry. */

  const collapsedClusterLayouts = useMemo(() => {
    const layouts = new Map<string, GraphBounds>();
    if (visibleNodes.length === 0) return layouts;

    const visibleBounds = getNodeBounds(visibleNodes);
    let detachedIndex = 0;

    for (const cluster of visibleClusters) {
      const visibleMembers = visibleNodes.filter((node) => cluster.nodeIds.includes(node.id));
      if (visibleMembers.length > 0) {
        const memberBounds = getNodeBounds(visibleMembers);
        const centerX = (memberBounds.minX + memberBounds.maxX) / 2;
        const centerY = (memberBounds.minY + memberBounds.maxY) / 2;
        const width = Math.max(104, Math.min(148, memberBounds.maxX - memberBounds.minX + 56));
        const height = Math.max(82, Math.min(112, memberBounds.maxY - memberBounds.minY + 56));
        layouts.set(cluster.id, {
          minX: centerX - width / 2,
          minY: centerY - height / 2,
          maxX: centerX + width / 2,
          maxY: centerY + height / 2,
        });
        continue;
      }

      const width = 118;
      const height = 82;
      const minX = visibleBounds.maxX + 24;
      const minY = visibleBounds.minY + detachedIndex * (height + 18);
      layouts.set(cluster.id, {
        minX,
        minY,
        maxX: minX + width,
        maxY: minY + height,
      });
      detachedIndex += 1;
    }

    return layouts;
  }, [visibleClusters, visibleNodes]);

  const expandedClusters = useMemo(
    () => CLUSTERS.filter((cluster) => state.expandedClusterIds.has(cluster.id)),
    [state.expandedClusterIds],
  );

  /* Node visuals — opacity, scale, dimming */

  const nodeVisuals = useMemo(() => {
    const visuals = new Map<
      string,
      { opacity: number; scale: number; dimmed: boolean; highlighted: boolean }
    >();

    const focusTarget = state.focusedId;
    const related = focusTarget
      ? directRelated.get(focusTarget) ?? new Set()
      : new Set();
    const indirect = focusTarget
      ? indirectRelated.get(focusTarget) ?? new Set()
      : new Set();

    for (const n of visibleNodes) {
      if (focusTarget) {
        if (n.id === focusTarget) {
          visuals.set(n.id, { opacity: 1, scale: 1.15, dimmed: false, highlighted: true });
        } else if (related.has(n.id)) {
          visuals.set(n.id, { opacity: 1, scale: 1, dimmed: false, highlighted: false });
        } else if (indirect.has(n.id)) {
          visuals.set(n.id, { opacity: 0.5, scale: 1, dimmed: true, highlighted: false });
        } else {
          visuals.set(n.id, { opacity: 0.35, scale: 1, dimmed: true, highlighted: false });
        }
      } else if (state.selectedId) {
        if (n.id === state.selectedId) {
          visuals.set(n.id, { opacity: 1, scale: 1.05, dimmed: false, highlighted: true });
        } else {
          visuals.set(n.id, { opacity: 0.7, scale: 1, dimmed: false, highlighted: false });
        }
      } else {
        visuals.set(n.id, { opacity: 1, scale: 1, dimmed: false, highlighted: false });
      }
    }
    return visuals;
  }, [state, visibleNodes, directRelated, indirectRelated]);

  /* Edge visuals */

  const edgeVisuals = useMemo(() => {
    const visuals = new Map<string, { opacity: number; stroke: string }>();
    const focusTarget = state.focusedId;

    for (const e of visibleEdges) {
      if (focusTarget) {
        const touchesFocus = e.from === focusTarget || e.to === focusTarget;
        const connectsDirectPeers =
          (directRelated.get(focusTarget)?.has(e.from) ?? false) &&
          (directRelated.get(focusTarget)?.has(e.to) ?? false);
        if (e.type === "direct" && touchesFocus) {
          visuals.set(e.id, { opacity: 0.9, stroke: "#c084fc" });
        } else if (e.type === "direct" && connectsDirectPeers) {
          visuals.set(e.id, { opacity: 0.38, stroke: "var(--hermes-color-text-secondary)" });
        } else if (e.type === "indirect") {
          visuals.set(e.id, { opacity: 0.25, stroke: "var(--hermes-color-text-disabled)" });
        } else {
          visuals.set(e.id, { opacity: 0.18, stroke: "var(--hermes-color-text-disabled)" });
        }
      } else {
        visuals.set(e.id, {
          opacity: e.type === "direct" ? 0.6 : 0.34,
          stroke: e.type === "direct"
            ? "var(--hermes-color-text-secondary)"
            : "var(--hermes-color-text-disabled)",
        });
      }
    }
    return visuals;
  }, [visibleEdges, state.focusedId, directRelated]);

  /* Find which cluster a focused node belongs to (for expand trigger) */

  const focusedCluster = useMemo(() => {
    if (!state.focusedId) return null;
    return findClusterForNode(state.focusedId) ?? null;
  }, [state.focusedId]);

  const isFocusedClusterExpanded = useMemo(() => {
    if (!focusedCluster) return false;
    return state.expandedClusterIds.has(focusedCluster.id);
  }, [focusedCluster, state.expandedClusterIds]);

  /* Event handlers */

  const handleNodeClick = useCallback(
    (id: string) => {
      if (state.selectedId === id) {
        dispatch({ type: "focus", id });
      } else {
        dispatch({ type: "select", id });
      }
    },
    [state.selectedId],
  );

  const handleNodeDoubleClick = useCallback(
    (id: string) => {
      if (state.focusedId === id) {
        onInspectingChange(id);
      }
    },
    [state.focusedId, onInspectingChange],
  );

  const handleExpand = useCallback(
    (nodeId: string) => {
      dispatch({ type: "toggle-focused-cluster", nodeId });
    },
    [],
  );

  const handleClusterClick = useCallback(
    (clusterId: string) => {
      if (!state.focusedId || focusedCluster?.id !== clusterId) return;
      handleExpand(state.focusedId);
    },
    [focusedCluster, handleExpand, state.focusedId],
  );

  const handleNodeKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleNodeClick(id);
      } else if (e.key === "i") {
        e.preventDefault();
        if (state.focusedId === id) {
          onInspectingChange(id);
        }
      } else if (e.key === "x") {
        e.preventDefault();
        handleExpand(id);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const ids = visibleNodes.map((n) => n.id);
        const idx = ids.indexOf(id);
        const next = ids[(idx + 1) % ids.length];
        const el = nodeRefs.current.get(next);
        el?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const ids = visibleNodes.map((n) => n.id);
        const idx = ids.indexOf(id);
        const next = ids[(idx - 1 + ids.length) % ids.length];
        const el = nodeRefs.current.get(next);
        el?.focus();
      }
    },
    [visibleNodes, handleNodeClick, handleExpand, onInspectingChange, state.focusedId],
  );

  const handleGlobalKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return;

      e.preventDefault();
      e.stopPropagation();
      if (inspectingId) {
        onInspectingChange(null);
        return;
      }

      dispatch({ type: "return" });
    },
    [inspectingId, onInspectingChange],
  );

  /* Inspected node */

  const inspectedNode = inspectingId
    ? NODES.find((n) => n.id === inspectingId)
    : null;

  /* SVG viewBox */

  const viewBoxMetrics = useMemo(() => {
    if (visibleNodes.length === 0) {
      return { x: 0, y: 0, width: 800, height: 400 };
    }

    const nodeBounds = getNodeBounds(visibleNodes);
    let minX = nodeBounds.minX;
    let minY = nodeBounds.minY;
    let maxX = nodeBounds.maxX;
    let maxY = nodeBounds.maxY;

    for (const bounds of collapsedClusterLayouts.values()) {
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }

    const pad = 72;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [collapsedClusterLayouts, visibleNodes]);

  const viewBox = `${viewBoxMetrics.x} ${viewBoxMetrics.y} ${viewBoxMetrics.width} ${viewBoxMetrics.height}`;

  const focusedNode = state.focusedId
    ? visibleNodes.find((node) => node.id === state.focusedId)
    : null;
  const graphStyle = focusedNode
    ? ({
        "--kc-focus-x": `${((focusedNode.x - viewBoxMetrics.x) / viewBoxMetrics.width) * 100}%`,
        "--kc-focus-y": `${((focusedNode.y - viewBoxMetrics.y) / viewBoxMetrics.height) * 100}%`,
      } as React.CSSProperties)
    : undefined;

  /* Preview state banner */

  const previewBanner = useMemo(() => {
    switch (effectivePreviewState) {
      case "loading":
        return (
          <div className="kc-preview-banner kc-preview-loading">
            <span className="kc-preview-dot" />
            Loading fixture data...
          </div>
        );
      case "empty":
        return (
          <div className="kc-preview-banner kc-preview-empty">
            No knowledge nodes available.
          </div>
        );
      case "degraded":
        return (
          <div className="kc-preview-banner kc-preview-degraded">
            Partial data — some nodes unavailable.
          </div>
        );
      case "unavailable":
        return (
          <div className="kc-preview-banner kc-preview-unavailable">
            Knowledge constellation unavailable in this context.
          </div>
        );
      case "error":
        return (
          <div className="kc-preview-banner kc-preview-error">
            Error loading fixture data.
          </div>
        );
      default:
        return null;
    }
  }, [effectivePreviewState]);

  /* Node rendering */

  function renderNodeShape(n: KnowledgeNode, v: { opacity: number; scale: number }) {
    const cx = n.x;
    const cy = n.y;
    const r = NODE_RADIUS;
    const isHovered = state.hoveredId === n.id;
    const interactionState = getInteractionState(n.id, state);

    const scale = isHovered && v.scale === 1 ? 1.06 : v.scale;
    const transform = `translate(${cx}, ${cy}) scale(${scale})`;

    let fill: string;
    switch (n.type) {
      case "source":
        fill = "var(--hermes-color-accent-primary)";
        break;
      case "note":
        fill = "var(--hermes-color-surface-elevated)";
        break;
      case "task":
        fill = "var(--hermes-color-surface-decision)";
        break;
      case "entity":
        fill = "var(--hermes-color-surface-elevated)";
        break;
      case "cluster":
        fill = "var(--hermes-color-surface-elevated)";
        break;
    }

    const strokeColor =
      n.evidence === "KNOWN"
        ? "#86efac"
        : n.evidence === "DERIVED"
          ? "#fbbf24"
          : "#93c5fd";

    const cluster = findClusterForNode(n.id);
    const showExpandIndicator = state.focusedId === n.id && cluster && !state.expandedClusterIds.has(cluster.id);

    const renderGeometry = (
      className: string,
      shapeFill: string,
      shapeStroke: string,
      strokeWidth: number,
    ) => {
      if (n.type === "source") {
        return (
          <polygon
            className={className}
            points={`0,${-r} ${r * 0.87},${r * 0.5} ${-r * 0.87},${r * 0.5}`}
            fill={shapeFill}
            stroke={shapeStroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        );
      }

      if (n.type === "task") {
        return (
          <rect
            className={className}
            x={-TASK_SIZE / 2}
            y={-TASK_SIZE / 2}
            width={TASK_SIZE}
            height={TASK_SIZE}
            rx={7}
            fill={shapeFill}
            stroke={shapeStroke}
            strokeWidth={strokeWidth}
          />
        );
      }

      return (
        <circle
          className={className}
          cx={0}
          cy={0}
          r={r}
          fill={shapeFill}
          stroke={shapeStroke}
          strokeWidth={strokeWidth}
        />
      );
    };

    return (
      <g
        key={n.id}
        ref={(el) => {
          if (el) nodeRefs.current.set(n.id, el);
        }}
        className={`kc-node is-${interactionState}${isHovered ? " is-hovered" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`${n.label} — ${NODE_TYPE_LABELS[n.type]}, ${EVIDENCE_LABELS[n.evidence]}, permission: ${PERMISSION_LABELS[n.permission]}${cluster ? `, cluster: ${cluster.label}` : ""}`}
        transform={transform}
        opacity={v.opacity}
        onClick={() => handleNodeClick(n.id)}
        onDoubleClick={() => handleNodeDoubleClick(n.id)}
        onKeyDown={(e) => handleNodeKeyDown(e, n.id)}
        onMouseEnter={() => dispatch({ type: "hover", id: n.id })}
        onMouseLeave={() => dispatch({ type: "hover", id: null })}
      >
        <circle className="kc-node-glow" cx={0} cy={0} r={r + 7} />
        <circle className="kc-node-selection-ring" cx={0} cy={0} r={r + 5} stroke={strokeColor} />
        <circle className="kc-node-focus-ring" cx={0} cy={0} r={r + 7} />
        <circle className="kc-node-keyboard-ring" cx={0} cy={0} r={r + 11} />

        <g filter={v.opacity > 0.25 ? "url(#kc-node-shadow)" : undefined}>
          {renderGeometry("kc-node-shape", fill, strokeColor, 1.25)}
        </g>
        {renderGeometry("kc-node-highlight", "url(#kc-node-top-light)", "none", 0)}

        {/* Expand indicator */}
        {showExpandIndicator && (
          <g
            className="kc-expand-indicator"
            onClick={(e) => {
              e.stopPropagation();
              handleExpand(n.id);
            }}
            role="button"
            aria-label={`Expand cluster ${cluster!.label}`}
            tabIndex={-1}
          >
            <circle cx={r + 8} cy={-r + 4} r={8} fill="var(--hermes-color-surface-elevated)" stroke="var(--hermes-color-border-subtle)" strokeWidth={1} />
            <text x={r + 8} y={-r + 8} textAnchor="middle" fontSize={10} fill="var(--hermes-color-text-secondary)" pointerEvents="none">+</text>
          </g>
        )}

        {/* Labels */}
        <text className="kc-node-label" y={r + 16}>
          {n.label}
        </text>
        <text className="kc-node-type-label" y={r + 28}>
          {NODE_TYPE_LABELS[n.type]}
          {interactionState === "focused" ? " · FOCUSED" : ""}
        </text>
      </g>
    );
  }

  /* Render */

  return (
    <div
      className="kc-root"
      onKeyDown={handleGlobalKeyDown}
    >
      {/* Banner */}
      <div className="kc-banner">
        <div className="kc-banner-left">
          <span className="kc-banner-title">Knowledge Constellation</span>
          <span className="kc-badge">PROTOTYPE / FIXTURE DATA</span>
        </div>
        <div className="kc-legend">
          <span className="kc-legend-item">
            <span className="kc-legend-dot" style={{ background: "#86efac" }} />
            KNOWN
          </span>
          <span className="kc-legend-item">
            <span className="kc-legend-dot" style={{ background: "#fbbf24" }} />
            DERIVED
          </span>
          <span className="kc-legend-item">
            <span className="kc-legend-dot" style={{ background: "#93c5fd" }} />
            RELATED
          </span>
          <span className="kc-qa-control">
            <span className="kc-qa-label">QA:</span>
            {(["idle", "loading", "empty", "degraded", "unavailable", "error"] as const).map((ps) => (
              <button
                key={ps}
                type="button"
                className={`kc-qa-btn${effectivePreviewState === ps ? " is-active" : ""}`}
                onClick={() => setQaPreviewOverride(ps)}
                aria-label={`Set preview state to ${ps}`}
              >
                {ps}
              </button>
            ))}
            <button
              type="button"
              className="kc-qa-btn"
              onClick={() => setQaPreviewOverride(null)}
              aria-label="Reset preview state to default"
            >
              reset
            </button>
          </span>
        </div>
      </div>

      {/* Preview state banner */}
      {previewBanner}

      {/* Graph area */}
      <div className={`kc-graph-area${focusedNode ? " has-focus" : ""}`} style={graphStyle}>
        <svg
          ref={svgRef}
          className="kc-graph-svg"
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Knowledge constellation graph with fixture nodes and edges"
        >
          <defs>
            <linearGradient id="kc-node-top-light" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity={0.09} />
              <stop offset="0.6" stopColor="#ffffff" stopOpacity={0} />
            </linearGradient>
            <filter id="kc-node-shadow" x="-60%" y="-60%" width="220%" height="240%">
              <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#000000" floodOpacity="0.55" />
            </filter>
            <filter id="kc-node-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="9" />
            </filter>
          </defs>

          {/* Expanded clusters keep only a ghost caption; their boundary dissolves. */}
          {expandedClusters.map((cluster) => {
            const clusterNodes = visibleNodes.filter((node) => cluster.nodeIds.includes(node.id));
            if (clusterNodes.length === 0) return null;
            const bounds = getNodeBounds(clusterNodes);
            return (
              <text
                key={cluster.id}
                className="kc-cluster-caption kc-cluster-caption-expanded"
                x={bounds.minX - CLUSTER_PADDING + 10}
                y={bounds.minY - CLUSTER_PADDING + 15}
              >
                {cluster.label.toUpperCase()}
              </text>
            );
          })}

          {/* Edges */}
          {visibleEdges.map((e) => {
            const fromNode = visibleNodes.find((n) => n.id === e.from);
            const toNode = visibleNodes.find((n) => n.id === e.to);
            if (!fromNode || !toNode) return null;
            const v = edgeVisuals.get(e.id);
            const endpoints = getEdgeEndpoints(fromNode, toNode);
            const labelPosition = getEdgeLabelPosition(fromNode, toNode);
            const labelWidth = e.label ? Math.max(36, e.label.length * 5.4 + 12) : 0;
            return (
              <g key={e.id}>
                <line
                  className={`kc-edge${e.type === "indirect" ? " kc-edge-indirect" : ""}`}
                  x1={endpoints.x1}
                  y1={endpoints.y1}
                  x2={endpoints.x2}
                  y2={endpoints.y2}
                  opacity={v?.opacity ?? 0.6}
                  stroke={v?.stroke ?? "var(--hermes-color-text-disabled)"}
                />
                {e.label && (
                  <>
                    <rect
                      className="kc-edge-label-plate"
                      x={labelPosition.x - labelWidth / 2}
                      y={labelPosition.y - 9}
                      width={labelWidth}
                      height={14}
                      rx={3}
                      opacity={v?.opacity ?? 0.6}
                    />
                    <text
                      className="kc-edge-label"
                      x={labelPosition.x}
                      y={labelPosition.y + 1}
                      textAnchor="middle"
                      opacity={v?.opacity ?? 0.6}
                    >
                      {e.label.toUpperCase()}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* Cluster outlines (non-expanded) — clickable to expand */}
          {visibleClusters.map((c) => {
            const bounds = collapsedClusterLayouts.get(c.id);
            if (!bounds) return null;
            const canExpandFromOutline = focusedCluster?.id === c.id;
            return (
              <g key={c.id} className="kc-cluster-region">
                <rect
                  x={bounds.minX}
                  y={bounds.minY}
                  width={bounds.maxX - bounds.minX}
                  height={bounds.maxY - bounds.minY}
                  rx={18}
                  className="kc-cluster-outline"
                  onClick={canExpandFromOutline ? () => handleClusterClick(c.id) : undefined}
                  role={canExpandFromOutline ? "button" : undefined}
                  aria-label={canExpandFromOutline ? `Expand cluster: ${c.label}` : undefined}
                  tabIndex={canExpandFromOutline ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (canExpandFromOutline && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      handleClusterClick(c.id);
                    }
                  }}
                />
                <text
                  className="kc-cluster-caption"
                  x={bounds.minX + 12}
                  y={bounds.minY + 17}
                  pointerEvents="none"
                >
                  {c.label.toUpperCase()}
                  <tspan className="kc-cluster-count"> · {c.nodeIds.length}</tspan>
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {visibleNodes.map((n) => {
            const v = nodeVisuals.get(n.id) ?? {
              opacity: 1,
              scale: 1,
              dimmed: false,
              highlighted: false,
            };
            return renderNodeShape(n, v);
          })}
        </svg>

        {/* Zone B: no inspector — inspector lives in Zone C via ContextRail */}
      </div>

      {/* Hint bar */}
      <div className="kc-hint">
        <span>
          <kbd>Click</kbd> select &nbsp;
          <kbd>Click</kbd> again focus &nbsp;
          <kbd>I</kbd> inspect &nbsp;
          <kbd>X</kbd> expand &nbsp;
          <kbd>Esc</kbd> return
        </span>
        <span>
          <kbd>Arrows</kbd> navigate &nbsp;
          <kbd>Enter</kbd> / <kbd>Space</kbd> activate
        </span>
      </div>
    </div>
  );
}

/* Re-export types needed by parent */
export type { PreviewState };
