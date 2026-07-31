/**
 * Shell tool: timeout (SIGKILL fallback), denylist, output truncation,
 * cancellation via AbortSignal. Guardrails — not a security boundary; run
 * Faber in a container for untrusted code (see README).
 */
import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { ToolError, CancelledError } from "../errors.js";

const DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*[/~]\s*$/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\s*\{.*\};\s*:/,
  /\bsudo\b/,
  /\bshutdown\b|\breboot\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+777\s+\//,
];
const MAX_OUTPUT = 20_000;

export class ShellTool {
  constructor(private config: Config) {}

  run(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    for (const rx of DENY) {
      if (rx.test(command)) {
        throw new ToolError("Command blocked by safety policy (destructive or privileged pattern). Use a narrower, non-destructive command.");
      }
    }
    const timeout = Math.min(timeoutMs ?? this.config.shellTimeoutMs, 600_000);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, { shell: true, cwd: this.config.workspace });
      let out = "";
      let killed = false;
      const kill = (why: "timeout" | "cancel") => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        if (why === "timeout") {
          reject(new ToolError(`Command timed out after ${timeout / 1000}s. Consider a faster variant or run it in the background.`));
        } else {
          reject(new CancelledError());
        }
      };
      const timer = setTimeout(() => kill("timeout"), timeout);
      signal?.addEventListener("abort", () => { clearTimeout(timer); kill("cancel"); }, { once: true });

      const collect = (chunk: Buffer, label = "") => {
        if (out.length < MAX_OUTPUT * 2) out += (label && !out.endsWith(label) ? label : "") + chunk.toString();
      };
      child.stdout.on("data", (c) => collect(c));
      child.stderr.on("data", (c) => collect(c, "\n[stderr]\n"));
      child.on("error", (err) => { clearTimeout(timer); reject(new ToolError(`Failed to start command: ${err.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;
        let text = out;
        if (text.length > MAX_OUTPUT) {
          text = text.slice(0, MAX_OUTPUT / 2) + "\n...[output truncated]...\n" + text.slice(-MAX_OUTPUT / 2);
        }
        resolve(`[exit code: ${code ?? "?"}]\n${text.trim() || "(no output)"}`);
      });
    });
  }
}
