/**
 * Composed input: bracketed-paste handling for the terminal.
 *
 * Problem: readline emits one 'line' event per newline, so pasting a 50-line
 * code block becomes 50 separate submissions — each line misread as its own
 * instruction.
 *
 * Mechanism: we enable BRACKETED PASTE (ESC[?2004h) so the terminal wraps
 * pastes in ESC[200~ ... ESC[201~ markers, and interpose a transform between
 * stdin and readline that replaces newlines INSIDE a paste with a sentinel
 * byte (\x00). Readline then sees the entire paste as part of ONE line, the
 * user can keep typing before/after it (a paste without a trailing newline
 * just sits in the buffer), and only a real Enter submits. restore() swaps
 * sentinels back to newlines afterward.
 *
 * Terminals without bracketed paste degrade to the old line-per-line
 * behavior — steering still coalesces those at the drain boundary.
 */
import { PassThrough } from "node:stream";

export const SENTINEL = "\x00";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface ComposedInput {
  stream: PassThrough;            // feed this to readline as `input`
  setGuard: (on: boolean) => void; // true while the raw-mode selector owns stdin
  detach: () => void;
}

/** Replace \x00 sentinels with real newlines in a submitted line. */
export function restore(line: string): string {
  return line.split(SENTINEL).join("\n");
}

/** Human display for a composed submission. */
export function describeComposed(raw: string): string {
  const restored = restore(raw);
  const lines = restored.split("\n");
  if (lines.length <= 1) return restored.slice(0, 80);
  const typedTail = lines.at(-1)?.trim();
  return `[pasted ${lines.length} lines]${typedTail && typedTail.length < 60 ? ` + "${typedTail}"` : ""}`;
}

export function createComposedInput(source: NodeJS.ReadStream): ComposedInput {
  const out = new PassThrough();
  let inPaste = false;
  let guard = false;
  let tail = "";                   // carry partial escape markers across chunks

  const onData = (buf: Buffer): void => {
    if (guard) return;             // selector owns stdin; drop (it consumes keys)
    let s = tail + buf.toString("utf8");
    tail = "";
    // keep a possible partial marker for the next chunk
    for (let keep = Math.min(PASTE_START.length - 1, s.length); keep > 0; keep--) {
      const suffix = s.slice(-keep);
      if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) {
        tail = suffix;
        s = s.slice(0, -keep);
        break;
      }
    }
    let result = "";
    let i = 0;
    while (i < s.length) {
      if (!inPaste && s.startsWith(PASTE_START, i)) { inPaste = true; i += PASTE_START.length; continue; }
      if (inPaste && s.startsWith(PASTE_END, i)) { inPaste = false; i += PASTE_END.length; continue; }
      const ch = s[i]!;
      if (inPaste && (ch === "\n" || ch === "\r")) {
        result += SENTINEL;
        if (ch === "\r" && s[i + 1] === "\n") i++;  // CRLF -> one sentinel
      } else {
        result += ch;
      }
      i++;
    }
    if (result) out.write(result);
  };

  source.on("data", onData);
  source.on("end", () => out.end());
  return {
    stream: out,
    setGuard: (on) => { guard = on; },
    detach: () => source.removeListener("data", onData),
  };
}

export function enableBracketedPaste(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
}
export function disableBracketedPaste(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
}
