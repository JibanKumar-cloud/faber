/**
 * Deciding whether a line is a command.
 *
 * Kept in its own module because index.ts starts the CLI when imported, so a
 * test that reaches for this function would otherwise boot the whole program
 * and sit at a prompt forever.
 */
/**
 * How many arguments each command takes. Anything with more is prose.
 *
 * The old rule was "starts with a slash", which read only the first word — so
 * "/undo and /redo how does it work?" reverted the user's files while they
 * were asking a question about them. A command has to match the WHOLE line.
 */
const COMMAND_ARITY: Record<string, number> = {
  "/help": 0, "/exit": 0, "/quit": 0, "/undo": 0, "/redo": 0, "/clear": 0,
  "/compact": 0, "/sessions": 0, "/history": 0, "/index": 0, "/setup": 0,
  "/route": 0, "/ask": 0, "/auto": 0, "/verbose": 0, "/concise": 0,
  "/usage": 1,      // --refresh-prices
  "/model": 1,      // an id, --save or --refresh
  "/profile": 1,    // a profile name
  "/map": 1, "/restore": 1, "/forget": 1, "/archive": 1, "/unarchive": 1,
  "/prune": 1, "/memory": 1,
  "/key": 2,        // set|rm plus a variable name
};

export function looksLikeCommand(line: string): boolean {
  // Trim first: a pasted or indented line is still a command.
  const parts = line.trim().split(/\s+/);
  if (!parts[0]?.startsWith("/")) return false;
  const arity = COMMAND_ARITY[parts[0]!.toLowerCase()];
  if (arity === undefined) return false;         // unknown: let /help catch it
  return parts.length - 1 <= arity;
}
