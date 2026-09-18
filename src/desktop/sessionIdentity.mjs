/**
 * The single selected-session identity for the whole desktop shell.
 *
 * Hermes is the sole canonical conversation owner. The desktop previously
 * also accepted a row from Yuzuki's legacy durable-session store here. That
 * allowed a local row to look active while the bridge remained attached to
 * a different Hermes session, so the next turn could land in the wrong
 * canonical conversation.
 *
 * Legacy rows are no longer a desktop conversation source. They are not
 * migrated, mapped, or deleted; they simply cannot supply an active send
 * identity. Search, Home, and New conversation all adopt a Hermes id.
 *
 * The id and title are still resolved together so a mismatched pair is not
 * representable.
 */

/**
 * @param {{ resumed?: { sessionId?: string|null, title?: string|null } | null }} [sources]
 * @returns {{ sessionId: string|null, title: string|null }}
 */
export function resolveActiveSession({ resumed = null } = {}) {
  if (resumed && resumed.sessionId) {
    return { sessionId: resumed.sessionId, title: resumed.title ?? null };
  }
  return { sessionId: null, title: null };
}
