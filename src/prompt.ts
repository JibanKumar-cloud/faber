/**
 * Interactive arrow-key selector for the terminal.
 *  - Up/Down (or j/k) moves, Enter confirms, 1-9 picks instantly.
 *  - Default cursor sits on the first (safest) option.
 *  - Ctrl-C / Esc cancels -> returns -1 (callers treat as "No").
 *  - Non-TTY (piped/CI) falls back to a numbered text prompt so scripts
 *    and the selftest harness keep working.
 */
import type * as readline from "node:readline/promises";
import pc from "picocolors";

let guardFn: ((on: boolean) => void) | undefined;
/** Wired by the CLI: pauses the composed-input pipe while the selector owns stdin. */
export function setSelectGuard(fn: (on: boolean) => void): void { guardFn = fn; }

export async function select(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const menu = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
    const ans = (await rl.question(
      `${question}\n${menu}\nChoose [1-${options.length}] (default ${defaultIndex + 1}): `,
    )).trim();
    const n = Number.parseInt(ans, 10);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defaultIndex;
  }

  console.log(pc.bold(question) + pc.dim("   ↑/↓ then Enter, or 1-9"));
  return new Promise<number>((resolve) => {
    let idx = defaultIndex;
    let firstRender = true;
    const render = (): void => {
      if (!firstRender) process.stdout.write(`\x1b[${options.length}A`);
      firstRender = false;
      for (let i = 0; i < options.length; i++) {
        process.stdout.write("\x1b[2K");
        process.stdout.write(
          (i === idx ? pc.cyan(`❯ ${options[i]}`) : pc.dim(`  ${options[i]}`)) + "\n",
        );
      }
    };

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    guardFn?.(true);
    rl.pause();
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (result: number): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      guardFn?.(false);
      rl.resume();
      resolve(result);
    };

    const onData = (buf: Buffer): void => {
      // A chunk may carry several keys (key repeat, paste, piped input) —
      // tokenize into individual sequences instead of comparing whole-chunk.
      const s = buf.toString();
      let done = false;
      for (let i = 0; i < s.length && !done; ) {
        let key: string;
        if (s[i] === "\x1b" && s[i + 1] === "[") { key = s.slice(i, i + 3); i += 3; }
        else { key = s[i]!; i += 1; }
        if (key === "\x1b[A" || key === "k") { idx = (idx - 1 + options.length) % options.length; render(); }
        else if (key === "\x1b[B" || key === "j") { idx = (idx + 1) % options.length; render(); }
        else if (key >= "1" && key <= "9" && Number(key) <= options.length) { idx = Number(key) - 1; render(); finish(idx); done = true; }
        else if (key === "\r" || key === "\n") { finish(idx); done = true; }
        else if (key === "\x03" || key === "\x1b") { finish(-1); done = true; }
      }
    };

    render();
    stdin.on("data", onData);
  });
}
