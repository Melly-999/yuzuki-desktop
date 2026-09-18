import { CHAT_MODE, MODEL_ROUTE_STATUS } from "./productTruth.mjs";
import {
  generateOpenAiCompatibleReply,
  generateOpenAiResponsesReply,
  ProviderAdapterError,
} from "./openAiCompatibleAdapter.mjs";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const MODEL_EXECUTION_PURPOSE = Object.freeze({
  SYNTHETIC_BENCHMARK: "SYNTHETIC_BENCHMARK",
  USER_CHAT: "USER_CHAT",
});

export const ROUTE_MODE = Object.freeze({
  AUTO: "AUTO",
  BALANCED: "BALANCED",
  DEEP: "DEEP",
  LOCAL: "LOCAL",
});

export const ROUTE_ROLE = Object.freeze({
  BALANCED_CLOUD: "BALANCED_CLOUD",
  DEEP_CLOUD: "DEEP_CLOUD",
  LOCAL_GENERAL: "LOCAL_GENERAL",
});

const USER_CHAT_CATALOG = Object.freeze({
  [ROUTE_MODE.AUTO]: Object.freeze({
    role: ROUTE_ROLE.BALANCED_CLOUD,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  }),
  [ROUTE_MODE.BALANCED]: Object.freeze({
    role: ROUTE_ROLE.BALANCED_CLOUD,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  }),
  [ROUTE_MODE.DEEP]: Object.freeze({
    role: ROUTE_ROLE.DEEP_CLOUD,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }),
  [ROUTE_MODE.LOCAL]: Object.freeze({
    role: ROUTE_ROLE.LOCAL_GENERAL,
    model: null,
    reasoningEffort: null,
  }),
});

export class ModelRouteError extends Error {
  constructor(
    message,
    {
      code = "PROVIDER_UNAVAILABLE",
      status = 503,
      retryable = false,
      requiresNextRun = null,
    } = {},
  ) {
    super(message);
    this.name = "ModelRouteError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requiresNextRun = requiresNextRun;
  }
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_MS ? timeout : null;
}

function customEndpoint(baseUrl, apiKey) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return null;
  }

  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (apiKey && parsed.protocol !== "https:" && !loopback) return null;

  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/chat/completions`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * The only server module that interprets HERMES model-routing environment
 * configuration. It returns only non-secret state to callers.
 */
function resolveBenchmarkConfig(env) {
  const route = trimmed(env.HERMES_MODEL_ROUTE).toLowerCase();
  const model = trimmed(env.HERMES_MODEL_NAME);
  const apiKey = trimmed(env.HERMES_MODEL_API_KEY);
  const baseUrl = trimmed(env.HERMES_MODEL_BASE_URL);
  const timeoutMs = parseTimeout(env.HERMES_MODEL_TIMEOUT_MS);

  if (!route || !model || timeoutMs === null) return { configured: false };

  if (route === "openrouter") {
    if (!apiKey) return { configured: false };
    return {
      configured: true,
      route,
      model,
      apiKey,
      endpoint: OPENROUTER_ENDPOINT,
      timeoutMs,
      mode: CHAT_MODE.HOSTED,
      routeStatus: MODEL_ROUTE_STATUS.HOSTED_NATIVE_OPENROUTER,
    };
  }

  if (route === "custom") {
    if (!baseUrl) return { configured: false };
    const endpoint = customEndpoint(baseUrl, apiKey);
    if (!endpoint) return { configured: false };
    return {
      configured: true,
      route,
      model,
      apiKey,
      endpoint,
      timeoutMs,
      mode: CHAT_MODE.LOCAL_DEV,
      routeStatus: MODEL_ROUTE_STATUS.HOSTED_NATIVE_CUSTOM_ENDPOINT,
    };
  }

  return { configured: false };
}

/**
 * Provider-neutral USER_CHAT override: when a base URL, model, and
 * credential are all present, USER_CHAT is served by the same
 * OpenAI-compatible chat-completions transport already used by the
 * SYNTHETIC_BENCHMARK custom-endpoint path, instead of the hardwired
 * OpenAI Responses catalog. No vendor name is ever referenced here.
 */
function resolveUserChatConfig(env) {
  const enabled = trimmed(env.HERMES_MODEL_CHAT_ENABLED) === "true";
  if (!enabled) return { enabled: false, configured: false };

  const timeoutMs = parseTimeout(env.HERMES_MODEL_TIMEOUT_MS);
  if (timeoutMs === null) return { enabled: true, configured: false };

  const compatBaseUrl = trimmed(env.HERMES_USER_CHAT_BASE_URL);
  const compatModel = trimmed(env.HERMES_USER_CHAT_MODEL);
  const compatApiKey = trimmed(env.HERMES_USER_CHAT_API_KEY);
  if (compatBaseUrl && compatModel && compatApiKey) {
    const endpoint = customEndpoint(compatBaseUrl, compatApiKey);
    if (!endpoint) return { enabled: true, configured: false };
    return {
      enabled: true,
      configured: true,
      transport: "compatible",
      endpoint,
      model: compatModel,
      apiKey: compatApiKey,
      timeoutMs,
    };
  }

  const apiKey = trimmed(env.OPENAI_API_KEY);
  if (!apiKey) return { enabled: true, configured: false };

  return { enabled: true, configured: true, transport: "openai_responses", apiKey, timeoutMs };
}

/**
 * Safe configuration probe for validation. It deliberately omits the API
 * key and endpoint so configuration can be checked without exposing them.
 */
export function inspectModelRouteConfiguration({ env = process.env } = {}) {
  const config = resolveBenchmarkConfig(env);
  if (!config.configured) return { configured: false };
  return {
    configured: true,
    route: config.route,
    model: config.model,
    mode: config.mode,
    routeStatus: config.routeStatus,
    timeoutMs: config.timeoutMs,
  };
}

/** Safe user-chat configuration probe; the credential value is never returned. */
export function inspectUserChatConfiguration({ env = process.env } = {}) {
  const config = resolveUserChatConfig(env);
  return {
    enabled: config.enabled,
    configured: config.configured,
    ...(config.configured ? { timeoutMs: config.timeoutMs } : {}),
  };
}

function createCombinedSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function routeUserChat(message, { routeMode, env, fetchImpl, signal }) {
  const selected = USER_CHAT_CATALOG[routeMode];
  if (!selected) {
    throw new ModelRouteError("The requested model route is not supported.", {
      code: "INVALID_ROUTE",
      status: 400,
    });
  }

  if (selected.role === ROUTE_ROLE.LOCAL_GENERAL) {
    throw new ModelRouteError("A validated local model is not available.", {
      code: "LOCAL_MODEL_NOT_AVAILABLE",
      status: 503,
      requiresNextRun: "HERMES-GPT-OSS-20B-LOCAL-FIT-BAKEOFF-001",
    });
  }

  const state = resolveUserChatConfig(env);
  if (!state.enabled) return { kind: "not_configured" };
  if (!state.configured) {
    throw new ModelRouteError("The configured model provider is not configured.", {
      code: "PROVIDER_NOT_CONFIGURED",
      status: 503,
      requiresNextRun: "HERMES-OPENAI-PROVIDER-SMOKE-001",
    });
  }

  try {
    let result;
    let provider;
    let reasoningEffort = null;
    let routeStatus = MODEL_ROUTE_STATUS.IMPLEMENTED_NOT_LIVE_VERIFIED;

    if (state.transport === "compatible") {
      const combined = createCombinedSignal(signal, state.timeoutMs);
      try {
        result = await generateOpenAiCompatibleReply({
          config: { endpoint: state.endpoint, model: state.model, apiKey: state.apiKey },
          message,
          fetchImpl,
          signal: combined.signal,
        });
      } finally {
        combined.dispose();
      }
      provider = "compatible";
      routeStatus = MODEL_ROUTE_STATUS.HOSTED_NATIVE_CUSTOM_ENDPOINT;
    } else {
      result = await generateOpenAiResponsesReply({
        config: {
          apiKey: state.apiKey,
          timeoutMs: state.timeoutMs,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort,
        },
        message,
        fetchImpl,
        signal,
      });
      provider = "openai";
      reasoningEffort = selected.reasoningEffort;
    }

    return {
      kind: "success",
      mode: CHAT_MODE.HOSTED,
      routeStatus,
      routeMode,
      resolvedRole: selected.role,
      provider,
      reasoningEffort,
      fallback: { occurred: false, from: null, to: null, reason: null },
      ...result,
    };
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      throw new ModelRouteError(error.message, {
        code: error.code,
        status: error.status,
        retryable: error.retryable,
      });
    }
    throw new ModelRouteError("The configured model provider is unavailable.", {
      code: "PROVIDER_ERROR",
      status: 502,
      retryable: true,
    });
  }
}

/**
 * Single routing boundary for the preserved synthetic benchmark path and
 * explicitly enabled user chat. Unknown purposes remain fail-closed.
 */
export async function routeModelReply(
  message,
  {
    purpose,
    routeMode = ROUTE_MODE.AUTO,
    env = process.env,
    fetchImpl = globalThis.fetch,
    signal,
  } = {},
) {
  if (purpose === MODEL_EXECUTION_PURPOSE.USER_CHAT) {
    return routeUserChat(message, { routeMode, env, fetchImpl, signal });
  }
  if (purpose !== MODEL_EXECUTION_PURPOSE.SYNTHETIC_BENCHMARK) {
    return { kind: "not_configured" };
  }

  const config = resolveBenchmarkConfig(env);
  if (!config.configured) return { kind: "not_configured" };

  const combined = createCombinedSignal(signal, config.timeoutMs);
  try {
    const result = await generateOpenAiCompatibleReply({
      config,
      message,
      fetchImpl,
      signal: combined.signal,
    });
    return {
      kind: "success",
      mode: config.mode,
      routeStatus: config.routeStatus,
      ...result,
    };
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      throw new ModelRouteError(error.message, { retryable: error.retryable });
    }
    throw new ModelRouteError("The configured model provider is unavailable.");
  } finally {
    combined.dispose();
  }
}
