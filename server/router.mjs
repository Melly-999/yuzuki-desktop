import { applyCors, handlePreflight } from "./lib/cors.mjs";
import { handleHealth } from "./routes/health.mjs";
import { handleCapabilities } from "./routes/capabilities.mjs";
import { handleProductTruth } from "./routes/productTruth.mjs";
import { handleChat } from "./routes/chat.mjs";
import {
  handleHermesStatus,
  handleHermesRoutingOptions,
  handleHermesChat,
  handleHermesCua,
  handleHermesCancel,
  handleHermesSessions,
  handleHermesSearch,
  handleHermesResume,
  handleHermesNewSession,
  handleHermesApprovals,
  handleHermesApprovalRespond,
} from "./routes/hermesChat.mjs";
import { handleNotFound } from "./routes/notFound.mjs";
import {
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handlePatchSession,
  handleDeleteSession,
  handleGetSessionMessages,
} from "./routes/sessions.mjs";

export const DEFAULT_PORT = 8787;
export const HOST = "127.0.0.1";

/**
 * The scaffold's request router. Pure aside from dispatching to handlers
 * — importing this module has no side effects (no port binding), which is
 * what lets server/tests/session.test.mjs exercise real HTTP requests
 * against it via an ephemeral local server.
 */
export function createRouter({
  chatHandler = handleChat,
  hermesStatusHandler = handleHermesStatus,
  hermesRoutingOptionsHandler = handleHermesRoutingOptions,
  hermesChatHandler = handleHermesChat,
  hermesCuaHandler = handleHermesCua,
  hermesCancelHandler = handleHermesCancel,
  hermesSessionsHandler = handleHermesSessions,
  hermesSearchHandler = handleHermesSearch,
  hermesResumeHandler = handleHermesResume,
  hermesApprovalsHandler = handleHermesApprovals,
  hermesApprovalRespondHandler = handleHermesApprovalRespond,
} = {}) {
  return function requestRouter(req, res) {
    applyCors(req, res);
    if (handlePreflight(req, res)) return;

    const base = `http://${req.headers.host ?? `${HOST}:${DEFAULT_PORT}`}`;
    const { pathname } = new URL(req.url, base);

    if (req.method === "GET" && pathname === "/api/health") {
      return handleHealth(req, res);
    }
    if (req.method === "GET" && pathname === "/api/capabilities") {
      return handleCapabilities(req, res);
    }
    if (req.method === "GET" && pathname === "/api/product-truth") {
      return handleProductTruth(req, res);
    }
    if (req.method === "POST" && pathname === "/api/chat") {
      return chatHandler(req, res);
    }
    // Real local Hermes runtime path. Kept on its own prefix so it can
    // never share a code path with the legacy USER_CHAT prototype above.
    if (req.method === "GET" && pathname === "/api/hermes/status") {
      return hermesStatusHandler(req, res);
    }
    if (req.method === "GET" && pathname === "/api/hermes/routing-options") {
      return hermesRoutingOptionsHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/chat") {
      return hermesChatHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/cua") {
      return hermesCuaHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/cancel") {
      return hermesCancelHandler(req, res);
    }
    if (req.method === "GET" && pathname === "/api/hermes/sessions") {
      return hermesSessionsHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/search") {
      return hermesSearchHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/session") {
      return handleHermesNewSession(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/resume") {
      return hermesResumeHandler(req, res);
    }
    if (req.method === "GET" && pathname === "/api/hermes/approvals") {
      return hermesApprovalsHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/hermes/approval") {
      return hermesApprovalRespondHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/sessions") {
      return handleCreateSession(req, res);
    }
    if (req.method === "GET" && pathname === "/api/sessions") {
      const includeArchived = new URL(req.url, base).searchParams.get("include_archived") === "true";
      return handleListSessions(req, res, { includeArchived });
    }
    if (pathname.startsWith("/api/sessions/")) {
      const rest = pathname.slice("/api/sessions/".length);
      if (rest.endsWith("/messages")) {
        const id = rest.slice(0, -"/messages".length);
        if (req.method === "GET") {
          return handleGetSessionMessages(req, res, id);
        }
        return handleNotFound(req, res);
      }
      if (req.method === "GET") {
        return handleGetSession(req, res, rest);
      }
      if (req.method === "PATCH") {
        return handlePatchSession(req, res, rest);
      }
      if (req.method === "DELETE") {
        return handleDeleteSession(req, res, rest);
      }
      return handleNotFound(req, res);
    }

    return handleNotFound(req, res);
  };
}

export const router = createRouter();
