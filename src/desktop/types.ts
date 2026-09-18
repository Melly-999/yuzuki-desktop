export type ThemeId = "violet" | "ember";
export type LayoutId = "companion" | "focus" | "workspace" | "review";
export type WorkspaceMode = "chat" | "today" | "search" | "document" | "task" | "approval" | "preview";
export type RailTab = "context" | "files" | "review" | "approvals";

export type ActivityTag = "prototype" | "example" | "designed" | "unavailable" | "error";

export type ActivityEntry = {
  id: string;
  title: string;
  detail?: string;
  tag: ActivityTag;
  at: string;
};

export type ChatBubble = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Only present on assistant replies that actually came back from the API scaffold. */
  productTruthLabels?: string[];
};
