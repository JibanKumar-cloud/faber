/**
 * Live status line: "✳ Working… 14s" while the agent runs (a
 * heartbeat), finishing with "✳ Worked for 14s". Suspends itself while text
 * is streaming so it never interleaves with model output. TTY only.
 */
import pc from "picocolors";

const FRAMES = ["✳", "✢", "✳", "✻"];

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

export class StatusLine {
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private frame = 0;
  private suspended = false;
  private visible = false;

  constructor(private out: NodeJS.WriteStream, private enabled: boolean) {}

  start(): void {
    if (!this.enabled) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.suspended) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    this.out.write(
      `\r\x1b[2K` +
      pc.dim(`${FRAMES[this.frame]} Working… ${formatElapsed(Date.now() - this.startedAt)}  (ctrl-c to cancel, type to steer)`),
    );
    this.visible = true;
  }

  /** Clear the line before printing real output (tool lines, prompts). */
  clear(): void {
    if (this.visible) { this.out.write("\r\x1b[2K"); this.visible = false; }
  }

  /** Streaming text owns the terminal; stop redrawing until it finishes. */
  suspend(): void { this.clear(); this.suspended = true; }
  resume(): void { this.suspended = false; }

  /** Stop and print the final elapsed summary. */
  stop(): void {
    if (!this.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.clear();
    if (this.startedAt) {
      this.out.write(pc.dim(`✳ Worked for ${formatElapsed(Date.now() - this.startedAt)}\n`));
    }
  }
}
