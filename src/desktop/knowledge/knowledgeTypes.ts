export type KnowledgeEvidence =
  | "KNOWN"
  | "DERIVED"
  | "RELATED";

export type KnowledgePermission =
  | "stored"
  | "draft"
  | "restricted"
  | "unavailable";

export type KnowledgeNodeType =
  | "source"
  | "note"
  | "task"
  | "entity"
  | "cluster";

/** Relationship geometry — NOT evidence truth. */
export type KnowledgeEdgeType =
  | "direct"
  | "indirect";

export type KnowledgeNode = {
  id: string;
  label: string;
  type: KnowledgeNodeType;
  evidence: KnowledgeEvidence;
  permission: KnowledgePermission;
  provenance?: string;
  timestamp?: string;
  description?: string;
  clusterId?: string;
  x: number;
  y: number;
};

export type KnowledgeEdge = {
  id: string;
  from: string;
  to: string;
  type: KnowledgeEdgeType;
  label?: string;
};

export type KnowledgeCluster = {
  id: string;
  label: string;
  nodeIds: string[];
};

export type InteractionState =
  | "idle"
  | "selected"
  | "focused"
  | "expanded"
  | "inspecting";

export const EVIDENCE_LABELS: Record<KnowledgeEvidence, string> = {
  KNOWN: "KNOWN / STORED",
  DERIVED: "DERIVED / INFERRED",
  RELATED: "RELATED",
};

export const PERMISSION_LABELS: Record<KnowledgePermission, string> = {
  stored: "Stored",
  draft: "Draft",
  restricted: "Restricted",
  unavailable: "Unavailable",
};

export const NODE_TYPE_LABELS: Record<KnowledgeNodeType, string> = {
  source: "Source",
  note: "Note",
  task: "Task",
  entity: "Entity",
  cluster: "Cluster",
};
