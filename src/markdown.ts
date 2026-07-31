/**
 * Terminal markdown renderer — full inline and block set.
 * Inline: **bold**, *italic* or _italic_, ~~strike~~, `code`, [links](url) as
 * real OSC 8 hyperlinks. Block: headers, rules, blockquotes, bullet restyle,
 * box-drawn tables, fenced code with SYNTAX HIGHLIGHTING (small built-in
 * tokenizer, zero deps). A stateful LineRenderer powers both whole-text
 * rendering and live line-buffered streaming.
 */

const BOLD = "\x1b[1m", NOBOLD = "\x1b[22m";
const ITAL = "\x1b[3m", NOITAL = "\x1b[23m";
const STRIKE = "\x1b[9m", NOSTRIKE = "\x1b[29m";
const UNDER = "\x1b[4m", NOUNDER = "\x1b[24m";
const DIM = "\x1b[2m", NODIM = "\x1b[22m";
const CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", MAGENTA = "\x1b[35m", RESET_FG = "\x1b[39m";

const stripCodes = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");

function inline(s: string): string {
  s = s.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${NOBOLD}`);
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, `$1${ITAL}$2${NOITAL}`);
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, `$1${ITAL}$2${NOITAL}`);
  s = s.replace(/~~([^~]+)~~/g, `${STRIKE}$1${NOSTRIKE}`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, text, url) => `\x1b]8;;${url}\x07${UNDER}${CYAN}${text}${RESET_FG}${NOUNDER}\x1b]8;;\x07`);
  s = s.replace(/`([^`]+)`/g, `${CYAN}$1${RESET_FG}`);
  return s;
}

// ------------------------------------------------------ syntax highlighting
const KEYWORDS: Record<string, string[]> = {
  common: ["if", "else", "for", "while", "return", "break", "continue", "true", "false", "null", "new", "try", "catch", "finally", "throw", "switch", "case", "default", "in", "of", "do"],
  js: ["function", "const", "let", "var", "class", "extends", "import", "export", "from", "async", "await", "this", "typeof", "interface", "type", "enum", "implements", "undefined", "yield", "static", "readonly", "public", "private", "protected"],
  py: ["def", "class", "import", "from", "as", "with", "lambda", "None", "True", "False", "and", "or", "not", "is", "elif", "except", "raise", "pass", "yield", "self", "async", "await", "global", "assert", "del"],
  go: ["func", "package", "import", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "range", "var", "const", "nil"],
  rs: ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "Some", "None", "Ok", "Err", "self", "crate", "async", "await"],
  sh: ["echo", "export", "cd", "then", "fi", "done", "local", "function", "source", "exit"],
};
const kwSet = new Set([...KEYWORDS.common!, ...KEYWORDS.js!, ...KEYWORDS.py!, ...KEYWORDS.go!, ...KEYWORDS.rs!, ...KEYWORDS.sh!]);

/** Line-based highlighter: strings green, comments dim, numbers yellow, keywords magenta. */
export function highlightLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    // comments (rest of line)
    if (ch === "#" || (ch === "/" && line[i + 1] === "/")) {
      out += `${DIM}${line.slice(i)}${NODIM}`;
      return out;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      out += `${GREEN}${line.slice(i, Math.min(j + 1, line.length))}${RESET_FG}`;
      i = j + 1;
      continue;
    }
    // words: keywords / numbers / identifiers
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      if (kwSet.has(word)) out += `${MAGENTA}${word}${RESET_FG}`;
      else if (/^\d[\d_.]*$/.test(word)) out += `${YELLOW}${word}${RESET_FG}`;
      else out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ------------------------------------------------------------------ tables
function renderTable(rows: string[]): string[] {
  const CAP = 40;
  const parsed: string[][] = [];
  let headerRows = 1;
  for (const row of rows) {
    const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) { headerRows = parsed.length; continue; }
    parsed.push(cells);
  }
  if (!parsed.length) return rows;
  const nCols = Math.max(...parsed.map((r) => r.length));
  const widths = Array.from({ length: nCols }, (_, i) =>
    Math.min(CAP, Math.max(1, ...parsed.map((r) => stripCodes(inline(r[i] ?? "")).length))),
  );
  const cell = (raw: string, i: number, bold: boolean): string => {
    let text = inline(raw ?? "");
    let plain = stripCodes(text);
    if (plain.length > widths[i]!) { text = plain.slice(0, widths[i]! - 1) + "…"; plain = text; }
    const pad = " ".repeat(widths[i]! - plain.length);
    return bold ? `${BOLD}${text}${NOBOLD}${pad}` : `${text}${pad}`;
  };
  const rule = (l: string, m: string, r: string): string =>
    `${DIM}${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}${NODIM}`;
  const out: string[] = [rule("┌", "┬", "┐")];
  parsed.forEach((r, idx) => {
    out.push(`${DIM}│${NODIM} ` +
      widths.map((_, i) => cell(r[i] ?? "", i, idx < headerRows)).join(` ${DIM}│${NODIM} `) +
      ` ${DIM}│${NODIM}`);
    if (idx === headerRows - 1 && parsed.length > headerRows) out.push(rule("├", "┼", "┤"));
  });
  out.push(rule("└", "┴", "┘"));
  return out;
}

// ------------------------------------------------------------ line renderer
/**
 * Stateful renderer: feed complete lines, get rendered lines. Tracks fence
 * state across lines; buffers table rows until the table ends. Used for both
 * whole-document rendering and live streaming.
 */
export class LineRenderer {
  private inFence = false;
  private tableBuf: string[] = [];

  renderLine(line: string): string[] {
    if (/^\s*```/.test(line)) {
      const flushed = this.flushTable();
      this.inFence = !this.inFence;
      return flushed;                               // fence markers dropped
    }
    if (this.inFence) return [...this.flushTable(), `  ${highlightLine(line)}`];
    if (/^\s*\|.*\|\s*$/.test(line)) { this.tableBuf.push(line); return []; }
    const pre = this.flushTable();
    const header = /^(#{1,4})\s+(.*)$/.exec(line);
    if (header) return [...pre, `${BOLD}${inline(header[2]!)}${NOBOLD}`];
    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) return [...pre, `${DIM}${"─".repeat(30)}${NODIM}`];
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return [...pre, `${DIM}▌ ${NODIM}${ITAL}${inline(quote[1]!)}${NOITAL}`];
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) return [...pre, `${bullet[1]!}${CYAN}•${RESET_FG} ${inline(bullet[2]!)}`];
    return [...pre, inline(line)];
  }

  flushTable(): string[] {
    if (!this.tableBuf.length) return [];
    const t = renderTable(this.tableBuf);
    this.tableBuf = [];
    return t;
  }
  end(): string[] { return this.flushTable(); }
}

export function renderMarkdown(text: string): string {
  const lr = new LineRenderer();
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...lr.renderLine(line));
  out.push(...lr.end());
  return out.join("\n");
}

/**
 * Streaming renderer: feed arbitrary deltas; emits rendered COMPLETE lines
 * as they finish (line-buffered — inline markers never split across a line).
 * flush() renders any trailing partial line at end of turn.
 */
export class StreamRenderer {
  private partial = "";
  private lr = new LineRenderer();

  feed(delta: string): string {
    this.partial += delta;
    let out = "";
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      const line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      for (const r of this.lr.renderLine(line)) out += r + "\n";
    }
    return out;
  }
  flush(): string {
    let out = "";
    if (this.partial) {
      for (const r of this.lr.renderLine(this.partial)) out += r + "\n";
      this.partial = "";
    }
    for (const r of this.lr.end()) out += r + "\n";
    return out;
  }
}
