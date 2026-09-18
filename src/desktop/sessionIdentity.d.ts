export interface ResumedHermesSession {
  sessionId: string;
  title: string;
  messages: { role: string; text: string }[];
}

export interface ActiveSession {
  /** The session every consumer should key off, or null when none is open. */
  sessionId: string | null;
  /** The title for that same session — never borrowed from the other source. */
  title: string | null;
}

export function resolveActiveSession(sources?: {
  resumed?: Pick<ResumedHermesSession, "sessionId" | "title"> | null;
}): ActiveSession;
