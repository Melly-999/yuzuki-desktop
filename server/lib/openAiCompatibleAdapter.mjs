const MAX_OUTPUT_TOKENS = 512;

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export class ProviderAdapterError extends Error {
  constructor(
    message,
    { code = "PROVIDER_ERROR", status = 502, retryable = false, cause = null } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderAdapterError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function optionalFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(usage) {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
  }

  return {
    prompt_tokens: optionalNonNegativeInteger(usage.prompt_tokens),
    completion_tokens: optionalNonNegativeInteger(usage.completion_tokens),
    total_tokens: optionalNonNegativeInteger(usage.total_tokens),
    cost_usd: optionalFiniteNumber(usage.cost),
  };
}

function normalizeResponsesUsage(usage) {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cost_usd: null,
    };
  }

  return {
    input_tokens: optionalNonNegativeInteger(usage.input_tokens),
    output_tokens: optionalNonNegativeInteger(usage.output_tokens),
    total_tokens: optionalNonNegativeInteger(usage.total_tokens),
    cost_usd: null,
  };
}

function providerErrorForStatus(status) {
  if (status === 401 || status === 403) {
    return new ProviderAdapterError("The configured model provider rejected the request.");
  }
  if (status === 402) {
    return new ProviderAdapterError("The configured model provider could not authorize this request's cost.");
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderAdapterError("The configured model provider is temporarily unavailable.", {
      retryable: true,
    });
  }
  return new ProviderAdapterError("The configured model provider could not process the request.");
}

function openAiErrorForStatus(status) {
  if (status === 401 || status === 403) {
    return new ProviderAdapterError("The configured model provider rejected its credential.", {
      code: "AUTH_FAILURE",
      status: 502,
    });
  }
  if (status === 404) {
    return new ProviderAdapterError("The configured model is not available.", {
      code: "MODEL_NOT_AVAILABLE",
      status: 503,
    });
  }
  if (status === 408) {
    return new ProviderAdapterError("The model request timed out.", {
      code: "REQUEST_TIMEOUT",
      status: 504,
      retryable: true,
    });
  }
  return new ProviderAdapterError("The configured model provider could not process the request.", {
    code: "PROVIDER_ERROR",
    status: 502,
    retryable: status >= 500,
  });
}

function openAiLimitError(payload) {
  const error =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    !Array.isArray(payload.error)
      ? payload.error
      : null;
  const code = typeof error?.code === "string" ? error.code : null;

  if (code === "slow_down") {
    return new ProviderAdapterError("OpenAI request rate limit reached. Try again later.", {
      code: "RATE_LIMITED",
      status: 503,
      retryable: true,
    });
  }
  if (code === "credit_balance_exhausted" || code === "organization_usage_limit_exceeded") {
    return new ProviderAdapterError("OpenAI quota or usage limit prevents this request.", {
      code: "QUOTA_EXHAUSTED",
      status: 503,
    });
  }
  if (code === "organization_spend_limit_exceeded" || code === "project_spend_limit_exceeded") {
    return new ProviderAdapterError("OpenAI billing or spend limit prevents this request.", {
      code: "BILLING_NOT_AVAILABLE",
      status: 503,
    });
  }
  return new ProviderAdapterError(
    "The provider returned a limit condition that Yuzuki could not safely classify.",
    {
      code: "PROVIDER_LIMIT_UNKNOWN",
      status: 503,
    },
  );
}

async function openAiErrorForResponse(response) {
  if (response.status !== 429) return openAiErrorForStatus(response.status);

  let payload;
  try {
    payload = await response.json();
  } catch {
    return openAiLimitError(null);
  }
  return openAiLimitError(payload);
}

function malformedResponse(message = "The model provider returned an invalid response.") {
  return new ProviderAdapterError(message, {
    code: "MALFORMED_PROVIDER_RESPONSE",
    status: 502,
  });
}

/**
 * Parses only the raw Responses API text shape documented by OpenAI:
 * `output[] -> {type:"message", role:"assistant"} -> content[] ->
 * {type:"output_text", text}`. The SDK-only convenience `output_text`
 * property is deliberately ignored, as are reasoning/tool output items.
 */
export function parseOpenAiResponsesPayload(payload, requestedModel) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    payload.object !== "response"
  ) {
    throw malformedResponse();
  }

  if (payload.status === "cancelled") {
    throw new ProviderAdapterError("The model request was cancelled.", {
      code: "CANCELLED",
      status: 408,
    });
  }
  if (["failed", "incomplete", "in_progress", "queued"].includes(payload.status)) {
    throw new ProviderAdapterError("The model provider did not complete the response.", {
      code: "PROVIDER_ERROR",
      status: 502,
    });
  }
  if (
    payload.status !== "completed" ||
    (payload.error !== undefined && payload.error !== null) ||
    !Array.isArray(payload.output)
  ) {
    throw malformedResponse();
  }

  const servedModel = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!servedModel) throw malformedResponse("The model provider did not report model provenance.");
  if (servedModel !== requestedModel) {
    throw new ProviderAdapterError("The model provider served an unexpected model.", {
      code: "MODEL_NOT_AVAILABLE",
      status: 503,
    });
  }

  const textParts = [];
  for (const item of payload.output) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      item.type !== "message" ||
      item.role !== "assistant" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const part of item.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        !Array.isArray(part) &&
        part.type === "output_text" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        textParts.push(part.text);
      }
    }
  }

  const reply = textParts.join("").trim();
  if (!reply) throw malformedResponse("The model provider returned no usable text reply.");

  return {
    reply,
    requestedModel,
    servedModel,
    usage: normalizeResponsesUsage(payload.usage),
  };
}

function createProviderSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let abortKind = null;
  const abortFromParent = () => {
    abortKind = "cancelled";
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortKind = "timeout";
    controller.abort(new Error("provider timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    getAbortKind: () => abortKind,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function providerAbortError(abortKind, cause) {
  if (abortKind === "timeout") {
    return new ProviderAdapterError("The model request timed out.", {
      code: "REQUEST_TIMEOUT",
      status: 504,
      retryable: true,
      cause,
    });
  }
  if (abortKind === "cancelled") {
    return new ProviderAdapterError("The model request was cancelled.", {
      code: "CANCELLED",
      status: 408,
      cause,
    });
  }
  return null;
}

/**
 * Calls the official OpenAI Responses endpoint for bounded, stateless,
 * text-only generation. Raw provider objects never cross this adapter.
 */
export async function generateOpenAiResponsesReply({ config, message, fetchImpl, signal }) {
  const combined = createProviderSignal(signal, config.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: message,
          reasoning: { effort: config.reasoningEffort },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          text: { format: { type: "text" } },
          store: false,
        }),
        signal: combined.signal,
      });
    } catch (error) {
      const abortError = providerAbortError(combined.getAbortKind(), error);
      if (abortError) throw abortError;
      throw new ProviderAdapterError("The configured model provider could not be reached.", {
        code: "PROVIDER_ERROR",
        status: 502,
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) throw await openAiErrorForResponse(response);

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const abortError = providerAbortError(combined.getAbortKind(), error);
      if (abortError) throw abortError;
      throw new ProviderAdapterError("The model provider returned invalid JSON.", {
        code: "MALFORMED_PROVIDER_RESPONSE",
        status: 502,
        cause: error,
      });
    }

    return parseOpenAiResponsesPayload(payload, config.model);
  } finally {
    combined.dispose();
  }
}

/**
 * Calls one OpenAI-compatible chat-completions endpoint. Vendor-specific
 * response and error shapes stop here; callers receive only normalized
 * text, provenance, usage, and a safe ProviderAdapterError.
 */
export async function generateOpenAiCompatibleReply({ config, message, fetchImpl, signal }) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.route === "openrouter") headers["X-OpenRouter-Metadata"] = "enabled";

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: message }],
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderAdapterError("The model request was cancelled.", {
        retryable: true,
        cause: error,
      });
    }
    throw new ProviderAdapterError("The configured model provider could not be reached.", {
      retryable: true,
      cause: error,
    });
  }

  if (!response.ok) {
    // Provider error bodies are deliberately not parsed: they can contain
    // private URLs, account identifiers, or credential-adjacent details.
    throw providerErrorForStatus(response.status);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderAdapterError("The model provider returned an invalid response.", {
      cause: error,
    });
  }

  const reply = payload?.choices?.[0]?.message?.content;
  const servedModel = payload?.model;
  if (typeof reply !== "string" || reply.trim().length === 0) {
    throw new ProviderAdapterError("The model provider returned no usable reply.");
  }
  if (typeof servedModel !== "string" || servedModel.trim().length === 0) {
    throw new ProviderAdapterError("The model provider did not report model provenance.");
  }

  const normalizedServedModel = servedModel.trim();
  if (normalizedServedModel !== config.model) {
    throw new ProviderAdapterError("The model provider served an unexpected model.");
  }

  const usage = normalizeUsage(payload.usage);
  if (config.route === "openrouter" && usage.cost_usd === null) {
    throw new ProviderAdapterError("The model provider did not report attributable request cost.");
  }

  return {
    reply: reply.trim(),
    requestedModel: config.model,
    servedModel: normalizedServedModel,
    usage,
  };
}
