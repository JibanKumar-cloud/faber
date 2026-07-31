/**
 * Short-term memory: token-budgeted conversation window.
 * Over budget -> older turns are LLM-summarized into one [COMPRESSED HISTORY]
 * message; tool_use/tool_result pairs are never split across the boundary.
 */
import type { Message } from "../llm.js";
import type { LLMClient } from "../llm.js";

export const SUMMARY_MARKER = "[COMPRESSED HISTORY]";

export function estimateTokens(obj: unknown): number {
  try { return Math.max(1, JSON.stringify(obj).length >> 2); }
  catch { return Math.max(1, String(obj).length >> 2); }
}

export class ShortTermMemory {
  messages: Message[] = [];
  constructor(public tokenBudget = 60_000, public keepRecent = 12) {}

  add(m: Message): void { this.messages.push(m); }
  clear(): void { this.messages = []; }
  tokens(): number { return estimateTokens(this.messages); }

  async maybeCompact(llm: Pick<LLMClient, "summarize">, force = false): Promise<boolean> {
    if (!force && this.tokens() <= this.tokenBudget) return false;
    if (this.messages.length <= this.keepRecent) return false;
    let cut = this.messages.length - this.keepRecent;
    while (cut > 0 && this.messages[cut]!.content[0]?.type === "tool_result") cut--;
    if (cut <= 0) return false;

    const old = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const summary = await llm.summarize(
      render(old),
      "Summarize this coding-agent conversation history. Preserve: the user's goals, " +
      "decisions made, files created/modified and why, key facts learned about the " +
      "codebase, and any unresolved problems. Be dense; max 400 words.",
    );
    this.messages = [
      { role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER} Earlier context, compressed:\n${summary}` }] },
      ...recent,
    ];
    return true;
  }
}

function render(messages: Message[], maxBlock = 1500): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") lines.push(`${m.role}: ${b.text.slice(0, maxBlock)}`);
      else if (b.type === "tool_use") lines.push(`${m.role} -> tool ${b.name}(${JSON.stringify(b.input).slice(0, 400)})`);
      else lines.push(`tool result: ${b.content.slice(0, maxBlock)}`);
    }
  }
  return lines.join("\n");
}
