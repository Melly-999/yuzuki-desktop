import { EDGES, NODES } from "./knowledgeFixture";
import { EVIDENCE_LABELS, NODE_TYPE_LABELS, PERMISSION_LABELS } from "./knowledgeTypes";
import type { KnowledgeNode } from "./knowledgeTypes";

type Props = {
  nodeId: string;
  onClose: () => void;
};

function NodeGlyph({ node }: { node: KnowledgeNode }) {
  const stroke = node.evidence === "KNOWN" ? "#86efac" : node.evidence === "DERIVED" ? "#fbbf24" : "#93c5fd";
  return (
    <svg className="kc-inspector-node-glyph" viewBox="0 0 20 20" aria-hidden="true">
      {node.type === "source" ? (
        <polygon points="10,2.5 18,16.5 2,16.5" fill="var(--hermes-color-accent-primary)" stroke={stroke} strokeWidth={1} strokeLinejoin="round" />
      ) : node.type === "task" ? (
        <rect x={3} y={3} width={14} height={14} rx={3} fill="var(--hermes-color-surface-decision)" stroke={stroke} strokeWidth={1} />
      ) : (
        <circle cx={10} cy={10} r={7.5} fill="var(--hermes-color-surface-elevated)" stroke={stroke} strokeWidth={1} />
      )}
    </svg>
  );
}

export function KnowledgeInspector({ nodeId, onClose }: Props) {
  const node = NODES.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const relationships = EDGES.filter((edge) => edge.from === node.id || edge.to === node.id);

  return (
    <div className="kc-inspector-zone-c" aria-label="Knowledge Inspector">
      <div className="kc-inspector-zone-c-header">
        <div className="kc-inspector-zone-c-heading">
          <NodeGlyph node={node} />
          <div className="kc-inspector-zone-c-heading-copy">
            <span className="kc-inspector-zone-c-title">{node.label}</span>
            <span className="kc-inspector-zone-c-state">{NODE_TYPE_LABELS[node.type]} · Focused</span>
          </div>
        </div>
        <button type="button" className="kc-inspector-zone-c-close" onClick={onClose} aria-label="Close inspector">×</button>
      </div>
      <div className="kc-inspector-zone-c-body">
        <div className="kc-inspector-zone-c-meta-grid">
          <div className="kc-inspector-zone-c-field">
            <span className="kc-inspector-zone-c-label">Evidence</span>
            <span className={`kc-inspector-badge kc-inspector-badge-${node.evidence.toLowerCase()}`}>{EVIDENCE_LABELS[node.evidence]}</span>
          </div>
          <div className="kc-inspector-zone-c-field">
            <span className="kc-inspector-zone-c-label">Permission</span>
            <span className="kc-inspector-permission">{PERMISSION_LABELS[node.permission]}</span>
          </div>
        </div>
        {node.provenance && <div className="kc-inspector-zone-c-field kc-inspector-zone-c-provenance"><span className="kc-inspector-zone-c-label">Provenance</span><span className="kc-inspector-zone-c-value">{node.provenance}</span></div>}
        {node.description && <div className="kc-inspector-zone-c-field kc-inspector-zone-c-description"><span className="kc-inspector-zone-c-label">Description</span><span className="kc-inspector-zone-c-value">{node.description}</span></div>}
        <div className="kc-inspector-zone-c-field kc-inspector-zone-c-relationship-field">
          <span className="kc-inspector-zone-c-label">Relationships · {relationships.length}</span>
          {relationships.map((edge) => {
            const other = NODES.find((candidate) => candidate.id === (edge.from === node.id ? edge.to : edge.from));
            return <span key={edge.id} className="kc-inspector-rel-node">{other?.label ?? "Unknown node"} · {edge.label ?? edge.type}</span>;
          })}
        </div>
      </div>
    </div>
  );
}
