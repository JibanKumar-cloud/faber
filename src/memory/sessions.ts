/**
 * Session persistence — closes the biggest gap from v0.1.
 *
 * Every message is appended to .faber/sessions/<id>.jsonl AS IT HAPPENS
 * (append-only JSONL = crash-safe: a killed process loses at most the final
 * partial line, which is skipped on load). `faber --resume` or /resume
 * reloads the latest session's messages into short-term memory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "../llm.js";

export class SessionStore {
  private file: string;
  readonly id: string;

  constructor(private dir: string, resumeId?: string) {
    this.id = resumeId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(dir, `${this.id}.jsonl`);
  }

  append(message: Message): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(message) + "\n");
    } catch { /* persistence is best-effort; never break the task over it */ }
  }

  load(): Message[] {
    if (!fs.existsSync(this.file)) return [];
    const out: Message[] = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip torn final line */ }
    }
    return out;
  }

  static latestId(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    const last = files.at(-1);
    return last?.replace(/\.jsonl$/, "");
  }

  static list(dir: string): { id: string; messages: number; bytes: number }[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => {
      const p = path.join(dir, f);
      const text = fs.readFileSync(p, "utf8");
      return {
        id: f.replace(/\.jsonl$/, ""),
        messages: text.split("\n").filter((l) => l.trim()).length,
        bytes: fs.statSync(p).size,
      };
    });
  }

  /** Cheap digest of the most recent session (no LLM call): first ask + last answer. */
  static lastSessionInfo(dir: string, excludeId?: string):
    { id: string; messages: number; ageMs: number; digest: string } | undefined {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
      : [];
    const file = files.reverse().find((f) => f.replace(/\.jsonl$/, "") !== excludeId);
    if (!file) return undefined;
    const p = path.join(dir, file);
    const messages = new SessionStore(dir, file.replace(/\.jsonl$/, "")).load();
    if (!messages.length) return undefined;
    const textOf = (m: Message): string =>
      m.content.filter((b) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    const firstUser = messages.find((m) => m.role === "user" && textOf(m));
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m));
    const digest = [
      firstUser ? `asked: "${textOf(firstUser).slice(0, 140)}"` : "",
      lastAssistant ? `ended: "${textOf(lastAssistant).slice(0, 140)}"` : "",
    ].filter(Boolean).join(" — ");
    return {
      id: file.replace(/\.jsonl$/, ""),
      messages: messages.length,
      ageMs: Date.now() - fs.statSync(p).mtimeMs,
      digest,
    };
  }

  /**
   * Keyword search across past session transcripts. Scores each message by
   * term overlap (rarer/longer terms weigh more), returns the best snippets
   * with surrounding context. Zero dependencies; embeddings can replace the
   * scorer later behind the same signature.
   */
  static search(
    dir: string, query: string, limit = 5, excludeId?: string,
  ): { session: string; when: string; role: string; snippet: string; score: number }[] {
    const STOP = new Set([
      "the", "and", "for", "you", "did", "what", "when", "where", "who", "how",
      "about", "with", "that", "this", "was", "were", "our", "your", "have",
      "has", "had", "can", "could", "should", "would", "tell", "last", "time",
      "conversation", "session", "discuss", "discussed", "talk", "talked",
      "remember", "ask", "asked", "say", "said", "previous", "earlier",
    ]);
    const terms = (query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((t) => !STOP.has(t));
    if (!terms.length || !fs.existsSync(dir)) return [];
    const hits: { session: string; when: string; role: string; snippet: string; score: number }[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const id = f.replace(/\.jsonl$/, "");
      if (id === excludeId) continue;
      const when = new Date(fs.statSync(path.join(dir, f)).mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      for (const m of new SessionStore(dir, id).load()) {
        const text = m.content
          .map((b: any) => b.type === "text" ? b.text : b.type === "tool_result" ? String(b.content) : "")
          .join(" ");
        const lower = text.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (lower.includes(t)) score += Math.min(t.length, 10); // longer terms weigh more
        }
        if (score > 0) {
          // snippet centered on the first matching term
          const idx = Math.max(0, lower.indexOf(terms.find((t) => lower.includes(t))!) - 80);
          hits.push({ session: id, when, role: m.role, snippet: text.slice(idx, idx + 300).trim(), score });
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
