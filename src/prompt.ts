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

async function selectRaw(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const menu = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
    let ans: string;
    try {
      ans = (await rl.question(
        `${question}\n${menu}\nChoose [1-${options.length}] (default ${defaultIndex + 1}): `,
      )).trim();
    } catch {
      // stdin closed mid-prompt (piped input ran out, or Ctrl-D):
      // take the default rather than surfacing a readline stack trace.
      return defaultIndex;
    }
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
        // Ctrl-C or Esc cancels. Returning -1 used to leak out as an array
        // index, crashing the caller with "cannot read properties of
        // undefined" — a cancel must be a clean exit, not a bad index.
        else if (key === "\x03" || key === "\x1b") { finish(-1); done = true; }
      }
    };

    render();
    stdin.on("data", onData);
  });
}


/**
 * Read a secret without echoing it. A pasted API key that appears on screen
 * survives in terminal scrollback, `script` logs, and screen recordings — so
 * the characters are consumed in raw mode and only a masked length is shown.
 * Falls back to a normal read when there's no TTY (CI piping a key in).
 */
export async function readSecret(
  rl: readline.Interface,
  promptText: string,
  io?: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream },
): Promise<string> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    return (await rl.question(promptText)).trim();
  }
  guardFn?.(true);
  rl.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(promptText);

  return new Promise<string>((resolve) => {
    let value = "";
    const done = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      guardFn?.(false);
      rl.resume();
      stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (buf: Buffer): void => {
      // Terminals wrap pasted text in bracketed-paste markers, ESC[200~ before
      // and ESC[201~ after. The ESC byte is below space and gets dropped by the
      // printable test below, but "[200~" is ordinary text and would be glued
      // onto the secret — which is how a pasted key ends up rejected as
      // malformed. Strip the markers, and any other escape sequence, first.
      const chunk = buf.toString("utf8")
        .replace(/\x1b\[20[01]~/g, "")
        .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "")
        .replace(/\x1b./g, "");
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\x03") { value = ""; return done(); }        // Ctrl-C
        if (ch === "\x7f" || ch === "\b") {                      // backspace
          if (value.length) value = value.slice(0, -1);
          continue;
        }
        // Echo nothing at all, the way sudo and ssh do. Masking characters
        // would still reveal the key's length, and a hundred dots for a long
        // key looks like something went wrong.
        if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}


/**
 * Arrow-key menu. Cancelling (Ctrl-C or Esc) exits the process cleanly rather
 * than returning a sentinel index that every caller would have to check —
 * one forgotten check produced a raw TypeError mid-setup.
 */
export async function select(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  const picked = await selectRaw(rl, question, options, defaultIndex);
  if (picked < 0 || picked >= options.length) {
    process.stdout.write("\n");
    rl.close();
    process.exit(130);        // 128 + SIGINT, the conventional cancel code
  }
  return picked;
}
