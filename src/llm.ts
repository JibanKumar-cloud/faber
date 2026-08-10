/**
 * Provider abstraction with STREAMING.
 * Internal message format is Anthropic-shaped (content blocks); the OpenAI
 * adapter converts at the boundary. Both providers stream via SSE so users
 * see text as it is generated, and AbortSignal cancels mid-stream.
 */
import type { Config } from "./config.js";
import { signRequest, discoverAwsCredentials, type AwsCredentials } from "./sigv4.js";
import { priceFor } from "./pricing.js";
import { FatalError, TransientAPIError, withRetries, CancelledError } from "./errors.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message { role: "user" | "assistant"; content: ContentBlock[]; }

export interface ToolSchema { name: string; description: string; input_schema: object; }

export interface Usage {
  input: number;          // fresh (uncached) input tokens
  cacheRead: number;      // input tokens served from cache (~90% cheaper)
  cacheWrite: number;     // input tokens written to cache (small premium)
  output: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  rawContent: ContentBlock[];
  stopReason: string;
  usage: Usage;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Why the last model listing came back empty. "Couldn't reach the provider"
 * is not a useful thing to tell someone whose key demonstrably works — the
 * status code or error usually says exactly what went wrong.
 */
let lastListError: string | undefined;
export function lastModelListError(): string | undefined { return lastListError; }

/** AWS credentials discovered once per process for SigV4 routes. */
let awsCredsPromise: Promise<AwsCredentials | undefined> | undefined;

export class LLMClient {
  constructor(private config: Config) {
    // Local servers (Ollama, LM Studio, vLLM on localhost) accept any bearer
    // token, so requiring a key there would block the one route that is free.
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(config.baseUrl);
    // Routes that sign with AWS credentials need no API key at all — in
    // SageMaker Studio, ECS or Lambda the execution role supplies them.
    if (!config.apiKey && config.route === "bedrock") return;
    if (!config.apiKey && isLocal) {
      this.config = { ...config, apiKey: "local" };
      return;
    }
    if (!config.apiKey) {
      const v = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      throw new FatalError(
        `No API key found. Set ${v}, or run /route to pick a local model that doesn't need one.`,
      );
    }
  }

  /**
   * Ask the provider which models this credential can actually use.
   * Anthropic: GET /v1/models  -> { data: [{ id, display_name }] }, newest first.
   * OpenAI-compatible (incl. Bedrock mantle, Ollama): GET /models, same shape
   * minus display_name. Returns [] on any failure — this is a convenience,
   * never a blocker, so an offline or restricted key just falls back.
   */
  /**
   * Check whether the provider accepts this credential.
   * "rejected" means the key is definitively wrong (401/403) — that is a
   * failed setup. "unreachable" covers being offline or an endpoint without a
   * models route, which says nothing about the key and must not block setup.
   */
  async verifyKey(): Promise<"ok" | "rejected" | "unreachable"> {
    const anthropic = this.config.provider === "anthropic";
    const url = anthropic ? `${this.config.baseUrl}/v1/models?limit=1`
                          : `${this.config.baseUrl}/models`;
    const headers: Record<string, string> = anthropic
      ? { "x-api-key": this.config.apiKey!, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${this.config.apiKey}` };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) return "rejected";
      return res.ok ? "ok" : "unreachable";
    } catch {
      return "unreachable";
    }
  }

  async listModels(signal?: AbortSignal): Promise<{ id: string; name?: string; created?: number }[]> {
    lastListError = undefined;
    const anthropic = this.config.provider === "anthropic";
    const url = anthropic
      ? `${this.config.baseUrl}/v1/models?limit=100`
      : `${this.config.baseUrl}/models`;
    const headers: Record<string, string> = anthropic
      ? { "x-api-key": this.config.apiKey!, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${this.config.apiKey}` };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      signal?.addEventListener("abort", () => ctl.abort(), { once: true });
      const res = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        lastListError = `HTTP ${res.status} from ${url}`;
        return [];
      }
      const body = await res.json() as {
        data?: { id?: string; display_name?: string; created?: number; created_at?: string }[];
      };
      return (body.data ?? [])
        .filter((m): m is { id: string; display_name?: string; created?: number; created_at?: string } =>
          typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          name: m.display_name,
          // OpenAI sends a unix timestamp; Anthropic an ISO date. Either way
          // this is the release date the picker sorts on.
          created: typeof m.created === "number" ? m.created
            : m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) || undefined
            : undefined,
        }));
    } catch (e) {
      lastListError = e instanceof Error ? e.message : String(e);
      return [];   // offline, no permission, or an endpoint without the route
    }
  }

  /**
   * Auth for one request. An API key is a header; AWS credentials mean signing
   * the whole request, which is how an IAM role authenticates with no key.
   */
  private async authHeaders(url: string, body: string): Promise<Record<string, string>> {
    if (this.config.apiKey) return { "x-api-key": this.config.apiKey };
    if (this.config.route !== "bedrock") return {};
    awsCredsPromise ??= discoverAwsCredentials();
    const creds = await awsCredsPromise;
    if (!creds) {
      throw new FatalError(
        "No AWS credentials found for the Bedrock route. Set BEDROCK_API_KEY, " +
        "or run in an environment with an IAM role (SageMaker, ECS, EC2) " +
        "or `aws configure`.",
      );
    }
    return signRequest({
      method: "POST",
      url,
      body,
      region: this.config.region ?? "us-east-1",
      service: "bedrock",
      credentials: creds,
      headers: { "content-type": "application/json" },
    });
  }

  /** Switch model at runtime (/model). Cache prefixes are per-model. */
  setModel(id: string): void { this.config = { ...this.config, model: id }; }

  complete(
    system: string,
    messages: Message[],
    tools: ToolSchema[],
    onText?: (delta: string) => void,
    signal?: AbortSignal,
    modelOverride?: string,
  ): Promise<LLMResponse> {
    // Which OpenAI API a model speaks isn't a user setting — the dataset
    // records it per model, so route on that rather than asking anyone.
    const model = modelOverride ?? this.config.model;
    return withRetries(
      () => this.config.provider === "anthropic"
        ? this.anthropicStream(system, messages, tools, onText, signal, modelOverride)
        : usesResponsesApi(model)
          ? this.responsesStream(system, messages, tools, onText, signal, modelOverride)
          : this.openaiWithResponsesFallback(system, messages, tools, onText, signal, modelOverride),
      { maxAttempts: this.config.retryMaxAttempts, signal },
    );
  }

  /** Internal summarization: routed to the cheap weak model when configured. */
  async summarize(text: string, instruction: string): Promise<string> {
    const resp = await this.complete(
      "You are a precise summarizer. Output only the summary.",
      [{ role: "user", content: [{ type: "text", text: `${instruction}\n\n${text}` }] }],
      [],
      undefined,
      undefined,
      this.config.weakModel,
    );
    return resp.text;
  }

  // ------------------------------------------------------------- anthropic
  private async anthropicStream(
    system: string, messages: Message[], tools: ToolSchema[],
    onText?: (d: string) => void, signal?: AbortSignal, modelOverride?: string,
  ): Promise<LLMResponse> {
    // PROMPT CACHING: mark the stable prefix so repeated loop iterations pay
    // ~10% for everything already sent. Three breakpoints (max 4 allowed):
    // last tool schema, the system prompt, and the last message — the message
    // breakpoint moves forward each iteration, caching the growing history.
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
    );
    const cachedMessages = messages.map((m, i) => {
      if (i !== messages.length - 1 || !Array.isArray(m.content) || m.content.length === 0) return m;
      const content = m.content.map((b, j) =>
        j === m.content.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b,
      );
      return { ...m, content };
    });
    const body: Record<string, unknown> = {
      model: modelOverride ?? this.config.model,
      max_tokens: this.config.maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: cachedMessages,
      stream: true,
    };
    if (tools.length) body.tools = cachedTools;

    const url = `${this.config.baseUrl}/v1/messages`;
    const authHeaders = await this.authHeaders(url, JSON.stringify(body));
    const res = await this.post(url, {
      ...authHeaders,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }, body, signal);

    const blocks: ContentBlock[] = [];
    let stopReason = "end_turn";
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    // accumulate streamed tool_use JSON per block index
    const partialJson = new Map<number, string>();

    for await (const evt of sseEvents(res, signal)) {
      const data = evt as Record<string, any>;
      switch (data.type) {
        case "content_block_start": {
          const cb = data.content_block;
          if (cb.type === "text") blocks[data.index] = { type: "text", text: "" };
          else if (cb.type === "tool_use") {
            blocks[data.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
            partialJson.set(data.index, "");
          }
          break;
        }
        case "content_block_delta": {
          const d = data.delta;
          const blk = blocks[data.index];
          if (d.type === "text_delta" && blk?.type === "text") {
            blk.text += d.text;
            onText?.(d.text);
          } else if (d.type === "input_json_delta") {
            partialJson.set(data.index, (partialJson.get(data.index) ?? "") + d.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const blk = blocks[data.index];
          if (blk?.type === "tool_use") {
            const raw = partialJson.get(data.index) ?? "";
            try { blk.input = raw ? JSON.parse(raw) : {}; }
            catch { throw new TransientAPIError("Malformed tool JSON in stream; retrying."); }
          }
          break;
        }
        case "message_start": {
          const u = data.message?.usage;
          if (u) {
            usage.input = u.input_tokens ?? 0;
            usage.cacheRead = u.cache_read_input_tokens ?? 0;
            usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
          }
          break;
        }
        case "message_delta":
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data.usage?.output_tokens != null) usage.output = data.usage.output_tokens;
          break;
        case "error":
          throw new TransientAPIError(`Stream error: ${JSON.stringify(data.error).slice(0, 300)}`);
      }
    }
    const content = blocks.filter(Boolean);
    return {
      text: content.filter((b) => b.type === "text").map((b: any) => b.text).join(""),
      toolCalls: content.filter((b) => b.type === "tool_use").map((b: any) => ({ id: b.id, name: b.name, input: b.input })),
      rawContent: content,
      stopReason,
      usage,
    };
  }

  // ---------------------------------------------------------------- openai
  private async openaiStream(
    system: string, messages: Message[], tools: ToolSchema[],
    onText?: (d: string) => void, signal?: AbortSignal, modelOverride?: string,
  ): Promise<LLMResponse> {
    const oaMessages: Record<string, unknown>[] = [{ role: "system", content: system }];
    for (const m of messages) oaMessages.push(...toOpenAI(m));
    const body: Record<string, unknown> = { model: modelOverride ?? this.config.model, messages: oaMessages, stream: true, stream_options: { include_usage: true } };
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
    const res = await this.post(`${this.config.baseUrl}/chat/completions`, {
      Authorization: `Bearer ${this.config.apiKey}`,
      "content-type": "application/json",
    }, body, signal);

    let text = "";
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const evt of sseEvents(res, signal)) {
      const u = (evt as any).usage;
      if (u) {
        usage.input = (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0);
        usage.cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
        usage.output = u.completion_tokens ?? 0;
      }
      const delta = (evt as any).choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; onText?.(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    const toolCalls = [...calls.values()].map((c) => {
      let input: Record<string, unknown> = {};
      try { input = c.args ? JSON.parse(c.args) : {}; } catch { /* leave empty */ }
      return { id: c.id, name: c.name, input };
    });
    const rawContent: ContentBlock[] = [];
    if (text) rawContent.push({ type: "text", text });
    for (const c of toolCalls) rawContent.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    return { text, toolCalls, rawContent, stopReason: toolCalls.length ? "tool_use" : "end_turn", usage };
  }


  /**
   * Chat completions, retrying on the Responses API if the provider says the
   * model belongs there.
   *
   * Routing normally comes from the dataset, but a model can be missing from
   * it, or the local copy can predate the fields we read. Rather than failing
   * with a 404 the user can do nothing about, take the provider at its word
   * and retry on the endpoint it named.
   */
  private async openaiWithResponsesFallback(
    system: string, messages: Message[], tools: ToolSchema[],
    onText?: (d: string) => void, signal?: AbortSignal, modelOverride?: string,
  ): Promise<LLMResponse> {
    try {
      return await this.openaiStream(system, messages, tools, onText, signal, modelOverride);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/responses/i.test(msg) || !/endpoint|not supported/i.test(msg)) throw e;
      return this.responsesStream(system, messages, tools, onText, signal, modelOverride);
    }
  }

  // ------------------------------------------------------------- responses
  /**
   * OpenAI's Responses API — the only way to reach the codex models, which are
   * the coding-tuned ones a coding agent actually wants.
   *
   * Three things differ from chat completions, and each is a place to get it
   * wrong: the request carries `instructions` and `input` rather than a
   * `messages` array; the stream is a sequence of named events keyed by a
   * `type` field rather than `choices[].delta`; and usage arrives as
   * input_tokens/output_tokens, which the cost ledger reads directly, so a
   * mismatch here silently under-reports spend rather than failing loudly.
   */
  private async responsesStream(
    system: string, messages: Message[], tools: ToolSchema[],
    onText?: (d: string) => void, signal?: AbortSignal, modelOverride?: string,
  ): Promise<LLMResponse> {
    const input: Record<string, unknown>[] = [];
    for (const m of messages) input.push(...toResponsesInput(m));

    const body: Record<string, unknown> = {
      model: modelOverride ?? this.config.model,
      instructions: system,
      input,
      stream: true,
      max_output_tokens: this.config.maxTokens,
    };
    if (tools.length) {
      // Flatter than chat completions: no nested `function` object.
      body.tools = tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
    }

    const res = await this.post(`${this.config.baseUrl}/responses`, {
      Authorization: `Bearer ${this.config.apiKey}`,
      "content-type": "application/json",
    }, body, signal);

    let text = "";
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    // Tool calls arrive as items announced first, then filled in by argument
    // deltas addressed to the item's id.
    const calls = new Map<string, { id: string; name: string; args: string }>();

    for await (const evt of sseEvents(res, signal)) {
      const e = evt as Record<string, any>;
      switch (e.type) {
        case "response.output_text.delta": {
          const d = typeof e.delta === "string" ? e.delta : "";
          if (d) { text += d; onText?.(d); }
          break;
        }
        case "response.output_item.added": {
          const item = e.item;
          if (item?.type === "function_call") {
            calls.set(String(item.id ?? item.call_id), {
              id: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              args: typeof item.arguments === "string" ? item.arguments : "",
            });
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const key = String(e.item_id ?? "");
          const cur = calls.get(key) ?? { id: key, name: "", args: "" };
          cur.args += typeof e.delta === "string" ? e.delta : "";
          calls.set(key, cur);
          break;
        }
        case "response.function_call_arguments.done": {
          // Some responses send the complete arguments here instead of deltas.
          const key = String(e.item_id ?? "");
          const cur = calls.get(key);
          if (cur && !cur.args && typeof e.arguments === "string") cur.args = e.arguments;
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const u = e.response?.usage;
          if (u) {
            const cached = u.input_tokens_details?.cached_tokens ?? 0;
            usage.input = (u.input_tokens ?? 0) - cached;
            usage.cacheRead = cached;
            usage.output = u.output_tokens ?? 0;
          }
          break;
        }
        case "error":
        case "response.failed": {
          const msg = e.message ?? e.response?.error?.message ?? "stream failed";
          throw new FatalError(`Responses API error: ${String(msg)}`);
        }
        default: break;   // ignore lifecycle events we don't need
      }
    }

    const toolCalls = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = c.args ? JSON.parse(c.args) : {}; } catch { /* leave empty */ }
        return { id: c.id, name: c.name, input: parsed };
      });

    const rawContent: ContentBlock[] = [];
    if (text) rawContent.push({ type: "text", text });
    for (const c of toolCalls) {
      rawContent.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }
    return {
      text, toolCalls, rawContent,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage,
    };
  }

  // ------------------------------------------------------------------ http
  private async post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err: any) {
      if (err?.name === "AbortError") throw new CancelledError();
      throw new TransientAPIError(`network error: ${err?.message ?? err}`);
    }
    if (RETRYABLE.has(res.status)) {
      const ra = res.headers.get("retry-after");
      throw new TransientAPIError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        ra ? Number(ra) || undefined : undefined);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FatalError(`Authentication failed (HTTP ${res.status}). Check your API key.`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      // Record what the provider just told us. Neither OpenAI's catalogue nor
      // its /v1/models response flags retired models or says which endpoint a
      // model needs, so the failing request is the only reliable signal — and
      // remembering it keeps the model out of every future menu.
      const { classifyModelError, markUnusable } = await import("./models.js");
      const why = classifyModelError(body);
      if (why) markUnusable(this.config.model, why);

      // Some newer OpenAI models are only served by the Responses API, which
      // Faber doesn't speak yet. The raw 404 doesn't say what to do about it.
      if (/v1\/responses endpoint/i.test(body)) {
        // Not fatal: the caller retries this request on the Responses API.
        throw new FatalError(
          `${this.config.model} is served by the responses endpoint, not chat completions.`,
        );
      }
      if (/has been deprecated/i.test(body)) {
        throw new FatalError(
          `${this.config.model} has been deprecated by the provider.\n` +
          `  It won't be offered again. Pick another with /model.`,
        );
      }
      throw new FatalError(`API error HTTP ${res.status}: ${body}`);
    }
    return res;
  }
}

/** Parse an SSE response body into JSON events; tolerates chunk boundaries mid-line. */
async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!res.body) throw new TransientAPIError("Empty response body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new CancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try { yield JSON.parse(payload); } catch { /* skip malformed keep-alive lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}


/**
 * Convert a message to Responses API input items.
 *
 * The Responses API doesn't take a `messages` array of chat turns. It takes a
 * flat list of items where a tool call and its result are siblings rather than
 * nested inside an assistant turn — so one Faber message can expand into
 * several items. Tool calls are joined to their results by `call_id`.
 */
/**
 * Does this model require the Responses API? Answered by the pricing dataset's
 * `mode` and `supported_endpoints`, refreshed on every launch, so a model
 * released tomorrow routes correctly without a Faber update.
 */
export function usesResponsesApi(modelId: string): boolean {
  const p = priceFor(modelId);
  if (p?.mode === "responses") return true;
  if (p?.endpoints?.length) {
    return p.endpoints.includes("/v1/responses")
      && !p.endpoints.some((e) => e.includes("chat/completions"));
  }
  return false;
}

function toResponsesInput(m: Message): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text") texts.push(b.text);
    else if (b.type === "tool_use") {
      out.push({
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      });
    } else if (b.type === "tool_result") {
      out.push({
        type: "function_call_output",
        call_id: b.tool_use_id,
        output: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      });
    }
  }
  if (texts.length) {
    // input_text for what we send, output_text for what the model said
    const kind = m.role === "assistant" ? "output_text" : "input_text";
    out.unshift({ role: m.role, content: [{ type: kind, text: texts.join("\n") }] });
  }
  return out;
}

function toOpenAI(m: Message): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  const toolResults: Record<string, unknown>[] = [];
  for (const b of m.content) {
    if (b.type === "text") texts.push(b.text);
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
    } else if (b.type === "tool_result") {
      toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    }
  }
  if (texts.length || toolCalls.length) {
    const msg: Record<string, unknown> = { role: m.role, content: texts.join("\n") || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
  }
  out.push(...toolResults);
  return out;
}
