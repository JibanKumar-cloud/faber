/**
 * Raw-mode line editor with paste chips.
 *
 * v2: full cursor editing. Left/Right/Home/End/Delete, Ctrl-A/E/K/U,
 * Up/Down history. Rendering is SINGLE-ROW WINDOWED: long input scrolls
 * horizontally behind `…` markers instead of wrapping — so cursor math is
 * always exact and the "backspace can't cross a wrapped line" bug class
 * cannot exist. Multi-line pastes are atomic chips: one arrow-key step,
 * one backspace, never split.
 */
import pc from "picocolors";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

type Item =
  | { kind: "ch"; ch: string }
  | { kind: "chip"; value: string; label: string };

export class Composer {
  private buf: Item[] = [];
  private cursor = 0;                 // index into buf (0..buf.length)
  private history: string[] = [];
  private histIdx: number | null = null;
  private draftBeforeHistory = "";
  private inPaste = false;
  private pasteBuf = "";
  private tail = "";
  private pasteCount = 0;
  private active: "prompt" | "steer" | "off" = "off";
  private promptText = "";
  private resolveLine?: (line: string | null) => void;
  private steerCb?: (text: string) => void;
  private interruptCb?: () => void;
  private lastRender = "";
  private boundData = (b: Buffer) => this.onData(b);

  constructor(private stdin: NodeJS.ReadStream, private stdout: NodeJS.WriteStream) {}

  start(): void {
    this.stdout.write("\x1b[?2004h");
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on("data", this.boundData);
  }
  stop(): void {
    this.stdin.removeListener("data", this.boundData);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdout.write("\x1b[?2004l");
  }
  pause(): void { this.stdin.removeListener("data", this.boundData); }
  resume(): void { this.stdin.on("data", this.boundData); }
  onInterrupt(cb: () => void): void { this.interruptCb = cb; }

  readLine(prompt: string): Promise<string | null> {
    this.active = "prompt";
    this.promptText = prompt;
    this.reset();
    this.render();
    return new Promise((resolve) => { this.resolveLine = resolve; });
  }

  enterSteerMode(cb: (text: string) => void): void {
    this.active = "steer";
    this.reset();
    this.steerCb = cb;
  }
  exitSteerMode(): void { this.active = "off"; this.steerCb = undefined; this.reset(); }

  // ---------------------------------------------------------------- model
  private reset(): void {
    this.buf = []; this.cursor = 0; this.inPaste = false; this.pasteBuf = "";
    this.pasteCount = 0; this.histIdx = null; this.lastRender = ""; this.lastCursorRow = 0;
  }
  private compose(): string {
    return this.buf.map((it) => (it.kind === "ch" ? it.ch : it.value)).join("");
  }
  private setFromString(s: string): void {
    this.buf = [...s].map((ch) => ({ kind: "ch", ch } as Item));
    this.cursor = this.buf.length;
  }

  // --------------------------------------------------------------- render
  private lastCursorRow = 0;                       // row (0-based) where cursor sat after last render

  /**
   * TRUE MULTI-ROW render: the draft wraps across
   * terminal rows and the cursor is placed exactly, including across wrap
   * boundaries. Algorithm (same family as GNU readline / linenoise):
   *  1. return to the render origin (up lastCursorRow rows, column 0)
   *  2. clear everything below (ESC[J)
   *  3. print prompt + full colored content; if the content ends exactly at
   *     the last column, emit \n to COMMIT the pending wrap so row math is
   *     deterministic across terminals
   *  4. compute cursor (row, col) from display-cell width and move there
   */
  private render(): void {
    if (this.active !== "prompt") return;
    const cols = Math.max(8, this.stdout.columns || 80);
    const promptW = stripAnsi(this.promptText).length;

    const cells: { ch: string; chip: boolean }[] = [];
    const itemStartCell: number[] = [];
    for (const it of this.buf) {
      itemStartCell.push(cells.length);
      if (it.kind === "ch") cells.push({ ch: it.ch, chip: false });
      else for (const ch of it.label) cells.push({ ch, chip: true });
    }
    itemStartCell.push(cells.length);

    let colored = "";
    let inChip = false;
    for (const c of cells) {
      if (c.chip && !inChip) { colored += "\x1b[36m"; inChip = true; }
      if (!c.chip && inChip) { colored += "\x1b[39m"; inChip = false; }
      colored += c.ch;
    }
    if (inChip) colored += "\x1b[39m";

    const total = promptW + cells.length;
    const endCommitsWrap = total > 0 && total % cols === 0;
    const cursorCell = promptW + itemStartCell[this.cursor]!;
    const tRow = Math.floor(cursorCell / cols);
    const tCol = cursorCell % cols;
    const endRow = total === 0 ? 0 : Math.floor(total / cols) - (endCommitsWrap ? 0 : 0);
    // after printing (+ committed wrap \n when needed), terminal cursor is at:
    const printedEndRow = endCommitsWrap ? total / cols : Math.floor(total / cols);

    let out = "\r";
    if (this.lastCursorRow > 0) out += `\x1b[${this.lastCursorRow}A`;
    out += "\x1b[J";
    out += this.promptText + colored;
    if (endCommitsWrap) out += "\n";
    // move from printed end position to the target cursor cell
    const up = printedEndRow - tRow;
    if (up > 0) out += `\x1b[${up}A`;
    out += "\r";
    if (tCol > 0) out += `\x1b[${tCol}C`;
    this.lastCursorRow = tRow;
    this.lastRender = out;
    this.stdout.write(out);
    void endRow;
  }

  /** Move the terminal cursor to the end of the draft (before submit/clear). */
  private gotoEnd(): void {
    if (this.active !== "prompt") return;
    const cols = Math.max(8, this.stdout.columns || 80);
    const promptW = stripAnsi(this.promptText).length;
    const contentW = this.buf.reduce((n, it) => n + (it.kind === "ch" ? 1 : it.label.length), 0);
    const total = promptW + contentW;
    const endRow = total === 0 ? 0 : Math.floor((total % cols === 0 && total > 0 ? total - 1 : total) / cols);
    const down = endRow - this.lastCursorRow;
    if (down > 0) this.stdout.write(`\x1b[${down}B`);
    this.lastCursorRow = 0;
  }

  private echoSteer(s: string): void { this.stdout.write(pc.magenta(s)); }

  // ----------------------------------------------------------------- keys
  private onData(buf: Buffer): void {
    let s = this.tail + buf.toString("utf8");
    this.tail = "";
    for (let keep = Math.min(PASTE_START.length - 1, s.length); keep > 0; keep--) {
      const suffix = s.slice(-keep);
      if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) {
        this.tail = suffix; s = s.slice(0, -keep); break;
      }
    }
    let i = 0;
    let dirty = false;
    const done = (): boolean => this.active === "off";
    while (i < s.length && !done()) {
      if (!this.inPaste && s.startsWith(PASTE_START, i)) { this.inPaste = true; this.pasteBuf = ""; i += PASTE_START.length; continue; }
      if (this.inPaste) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) { this.pasteBuf += s.slice(i); return; }
        this.pasteBuf += s.slice(i, end);
        i = end + PASTE_END.length;
        this.inPaste = false;
        this.finishPaste();
        dirty = true;
        continue;
      }
      const ch = s[i]!;
      if (ch === "\x1b") {                          // escape sequences
        const seq = this.readEscape(s, i);
        i += seq.len;
        dirty = this.handleEscape(seq.code) || dirty;
        continue;
      }
      i++;
      switch (ch) {
        case "\r": case "\n": this.submit(); break;
        case "\x03": this.ctrlC(); break;
        case "\x04": this.ctrlD(); break;
        case "\x7f": case "\b": dirty = this.backspace() || dirty; break;
        case "\x01": this.cursor = 0; dirty = true; break;                    // Ctrl-A home
        case "\x05": this.cursor = this.buf.length; dirty = true; break;      // Ctrl-E end
        case "\x0b": this.buf.splice(this.cursor); dirty = true; break;       // Ctrl-K kill->end
        case "\x15": this.buf.splice(0, this.cursor); this.cursor = 0; dirty = true; break; // Ctrl-U
        default:
          if (ch >= " " || ch === "\t") {
            this.buf.splice(this.cursor, 0, { kind: "ch", ch });
            this.cursor++;
            if (this.active === "steer") this.echoSteer(ch);
            dirty = true;
          }
      }
    }
    if (dirty && this.active === "prompt") this.render();
  }

  private readEscape(s: string, i: number): { code: string; len: number } {
    if (s[i + 1] === "[" || s[i + 1] === "O") {
      let j = i + 2;
      while (j < s.length && !/[A-Za-z~]/.test(s[j]!)) j++;
      return { code: s.slice(i + 1, j + 1), len: j + 1 - i };
    }
    return { code: "", len: 1 };                    // bare Esc
  }

  private handleEscape(code: string): boolean {
    switch (code) {
      case "[D": this.cursor = Math.max(0, this.cursor - 1); return true;
      case "[C": this.cursor = Math.min(this.buf.length, this.cursor + 1); return true;
      case "[H": case "OH": case "[1~": this.cursor = 0; return true;
      case "[F": case "OF": case "[4~": this.cursor = this.buf.length; return true;
      case "[3~":                                    // forward delete
        if (this.cursor < this.buf.length) { this.buf.splice(this.cursor, 1); return true; }
        return false;
      case "[A": return this.historyStep(-1);        // up
      case "[B": return this.historyStep(+1);        // down
      case "": this.ctrlC(); return false;           // bare Esc = cancel, like Ctrl-C
      default: return false;
    }
  }

  private historyStep(dir: -1 | 1): boolean {
    if (this.active !== "prompt" || !this.history.length) return false;
    if (this.histIdx === null) {
      if (dir === 1) return false;
      this.draftBeforeHistory = this.compose();
      this.histIdx = this.history.length - 1;
    } else {
      this.histIdx += dir;
      if (this.histIdx >= this.history.length) {     // walked past newest -> restore draft
        this.histIdx = null;
        this.setFromString(this.draftBeforeHistory);
        return true;
      }
      this.histIdx = Math.max(0, this.histIdx);
    }
    this.setFromString(this.history[this.histIdx] ?? "");
    return true;
  }

  private finishPaste(): void {
    const raw = this.pasteBuf.replace(/\r\n?/g, "\n");
    this.pasteBuf = "";
    if (!raw) return;
    const lines = raw.split("\n").length;
    if (lines === 1 && raw.length < 200) {           // small paste: inline as chars
      for (const ch of raw) this.buf.splice(this.cursor++, 0, { kind: "ch", ch });
      if (this.active === "steer") this.echoSteer(raw);
      return;
    }
    // paste-again-to-expand: same content as the chip just before the cursor
    const prev = this.buf[this.cursor - 1];
    if (prev?.kind === "chip" && prev.value === raw) {
      this.buf.splice(this.cursor - 1, 1);
      this.cursor--;
      for (const ch of raw) this.buf.splice(this.cursor++, 0, { kind: "ch", ch });
      if (this.active === "steer") this.echoSteer(raw);
      return;
    }
    this.pasteCount++;
    const hint = this.pasteCount === 1 ? " — paste again to expand" : "";
    const label = `[pasted #${this.pasteCount} +${lines} lines${hint}]`;
    this.buf.splice(this.cursor++, 0, { kind: "chip", value: raw, label });
    if (this.active === "steer") this.stdout.write(pc.cyan(label));
  }

  private backspace(): boolean {
    if (this.cursor === 0) return false;
    const removed = this.buf.splice(this.cursor - 1, 1)[0]!;
    this.cursor--;
    if (this.active === "steer") {
      const w = removed.kind === "ch" ? 1 : removed.label.length;
      this.stdout.write("\b \b".repeat(w));
    }
    return true;
  }

  private submit(): void {
    const text = this.compose();
    this.gotoEnd();
    this.stdout.write("\n");
    if (this.active === "prompt") {
      if (text.trim()) this.history.push(text);
      const r = this.resolveLine; this.resolveLine = undefined; this.active = "off";
      r?.(text);
    } else if (this.active === "steer" && text.trim()) {
      this.steerCb?.(text);
      this.reset();
    } else {
      this.reset();
    }
  }

  private ctrlC(): void {
    if (this.active === "steer") { this.interruptCb?.(); return; }
    if (this.active === "prompt") {
      if (this.buf.length) { this.gotoEnd(); this.stdout.write("^C\n"); this.lastCursorRow = 0; this.reset(); this.render(); }
      else {
        const r = this.resolveLine; this.resolveLine = undefined; this.active = "off";
        this.stdout.write("\n");
        r?.(null);
      }
    }
  }
  private ctrlD(): void {
    if (this.active === "prompt" && !this.buf.length) {
      const r = this.resolveLine; this.resolveLine = undefined; this.active = "off";
      this.stdout.write("\n");
      r?.(null);
    }
  }

  static describe(text: string): string {
    const lines = text.split("\n");
    return lines.length <= 1 ? text.slice(0, 80) : `[${lines.length} lines]`;
  }
}
