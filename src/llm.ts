/**
 * Provider abstraction with STREAMING.
 * Internal message format is Anthropic-shaped (content blocks); the OpenAI
 * adapter converts at the boundary. Both providers stream via SSE so users
 * see text as it is generated, and AbortSignal cancels mid-stream.
 */
import type { Config } from "./config.js";
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

export class LLMClient {
  constructor(private config: Config) {
    if (!config.apiKey) {
      const v = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      throw new FatalError(`No API key found. Set ${v} or add it to .faber/config.json.`);
    }
  }

  complete(
    system: string,
    messages: Message[],
    tools: ToolSchema[],
    onText?: (delta: string) => void,
    signal?: AbortSignal,
    modelOverride?: string,
  ): Promise<LLMResponse> {
    return withRetries(
      () => this.config.provider === "anthropic"
        ? this.anthropicStream(system, messages, tools, onText, signal, modelOverride)
        : this.openaiStream(system, messages, tools, onText, signal, modelOverride),
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

    const res = await this.post(`${this.config.baseUrl}/v1/messages`, {
      "x-api-key": this.config.apiKey!,
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
    if (!res.ok) throw new FatalError(`API error HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
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
