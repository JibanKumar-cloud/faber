import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { CodeIndexer, SymbolNotFoundError } from "../src/indexer.js";

const compiler = createRequire(import.meta.url).resolve("typescript");
function fixture(t: TestContext, files: Record<string, string>, semantic = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faber-indexer-"));
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    // Avoid relying on filesystem clock resolution during incremental tests.
    const stamp = Date.now() / 1000 + writeCount++;
    fs.utimesSync(file, stamp, stamp);
  };
  let writeCount = 1;
  for (const [name, text] of Object.entries(files)) write(name, text);
  const dbPath = path.join(root, ".index.db");
  const index = new CodeIndexer(dbPath, root, { providers: false, typescript: semantic ? compiler : false });
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dbPath, index, write };
}

test("indexer: Python operators before parentheses are not heuristic calls", async t => {
  const { index } = fixture(t, { "probe.py": [
    "def fallback():", "    return 'GET'", "",
    "def choose(value, values):",
    "    methods = getattr(value, 'methods', None) or ('GET',)",
    "    enabled = value and (fallback())",
    "    denied = not (value)",
    "    member = value in (values)",
    "    identity = value is (None)",
    "    return fallback()", "",
  ].join("\n") });
  await index.build();
  assert.deepEqual(index.referencesFrom("choose").map(r => r.callee).sort(), ["fallback", "fallback", "getattr"]);
});

const keywordNames = {
  js: "function or(value) { return value; }\nfunction and(value) { return value; }\nfunction not(value) { return value; }\nfunction choose(value) {\n  or(value);\n  and(value);\n  not(value);\n}\n",
  ts: "function or(value: number) { return value; }\nfunction and(value: number) { return value; }\nfunction not(value: number) { return value; }\nfunction choose(value: number) {\n  or(value);\n  and(value);\n  not(value);\n}\n",
  go: "package probe\nfunc or(value int) int { return value }\nfunc and(value int) int { return value }\nfunc not(value int) int { return value }\nfunc choose(value int) {\n  or(value)\n  and(value)\n  not(value)\n}\n",
  rs: "fn or(value: i32) -> i32 { value }\nfn and(value: i32) -> i32 { value }\nfn not(value: i32) -> i32 { value }\nfn choose(value: i32) {\n  or(value);\n  and(value);\n  not(value);\n}\n",
};
for (const [ext, text] of Object.entries(keywordNames)) test(`indexer: Python keyword filtering preserves ${ext} functions`, async t => {
  const { index } = fixture(t, { [`probe.${ext}`]: text }); await index.build();
  for (const name of ["or", "and", "not"]) assert.equal(index.search(name).filter(s => s.name === name).length, 1);
  assert.deepEqual(index.referencesFrom("choose").map(r => r.callee).sort(), ["and", "not", "or"]);
});

test("indexer: the keyword parser upgrade removes old references without source edits", async t => {
  const { index, dbPath } = fixture(t, { "probe.py": "def choose(value):\n    return value or ('GET',)\n" });
  await index.build(); const owner = index.search("choose")[0]!;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE meta SET value='6' WHERE key='parser_version'").run();
    db.prepare("INSERT INTO call_refs (caller,callee,path,line,id,caller_id,target_id,status,dispatch,position) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("choose", "or", "probe.py", 2, "old-keyword-ref", owner.id, null, "heuristic", "unknown", 42);
  } finally { db.close(); }
  assert.ok(index.referencesFrom("choose").some(r => r.callee === "or"));
  await index.refresh();
  assert.ok(!index.referencesFrom("choose").some(r => r.callee === "or"));
});

test("indexer A1: anonymous class keywords never become symbols", async (t) => {
  const { index } = fixture(t, {
    "keywords.ts": "class Base {}\nconst a = new class extends Base {};\nconst b = class implements Runnable {};\n",
  });
  await index.build();
  assert.equal(index.search("extends").length, 0);
  assert.equal(index.search("implements").length, 0);
  assert.equal(index.search("Base")[0]?.kind, "class");
});

test("indexer A2/A4: block comment state preserves generator methods, with or without a space", async (t) => {
  const lines = [
    "/**",
    " * This interface is not a declaration.",
    " * showDelayedHover({})",
    " *entries() is also comment prose without a space",
    "function hiddenInBlock() {}",
    "  private hiddenMethod() {}",
    " */",
    "// class HiddenClass {}",
    "/* interface HiddenInline {} */ export function visible() {}",
    "class Collection {",
    "  *entries(): Iterator<unknown> { yield 1; }",
    "  * values() { yield 2; }",
    "  async *keys() { yield 3; }",
    "  private * spaced() { yield 4; }",
    "}",
    "/* class HiddenEnd {}",
  ];
  const { index } = fixture(t, { "comments.ts": lines.join("\r\n") });
  await index.build();
  const symbols = index.search("", 100);
  assert.deepEqual(symbols.map(s => s.name).sort(), ["Collection", "entries", "keys", "spaced", "values", "visible"].sort());
  assert.deepEqual(symbols.map(s => s.line).sort((a, b) => a - b), [9, 10, 11, 12, 13, 14]);
  for (const name of ["entries", "values", "keys", "spaced"]) {
    assert.equal(symbols.find(s => s.name === name)?.kind, "method");
  }
});

test("indexer W3: literal URLs, escapes, regex character classes and division do not start comments", async (t) => {
  const lines = [
    'const endpoint = "https://example.com/*path*/"; // class HiddenUrl {}',
    "const quoted = 'it\\'s /* still a string */'; // interface HiddenQuote {}",
    'const template = `https://example.com/${"path"}`;',
    'const slash = /[/*]/; // class HiddenRegex {}',
    'const double = /[//]/; // class HiddenDouble {}',
    'const value = total / count; /* class HiddenDivision {} */',
    'export function afterLiterals() {}',
    '/* function hiddenAfterLiterals() {} */',
    'export function afterComments() {}',
  ];
  const { index } = fixture(t, { "literals.ts": lines.join("\n") });
  await index.build();
  assert.deepEqual(index.search("", 100).map(s => s.name), ["afterComments", "afterLiterals"]);
});

test("indexer W3: hash comments in Python/Ruby/PHP and C-style comments in other languages", async (t) => {
  const { index } = fixture(t, {
    "a.py": "# def hiddenPy():\nurl = 'https://example.com'\ndef realPy():\n    return 10 // 2\n",
    "b.rb": "# class HiddenRuby\nclass RealRuby\nend\n",
    "c.php": "<?php\n# function hiddenPhp() {}\nfunction realPhp() {}\n",
    "d.go": "/*\nfunc hiddenGo() {}\n*/\nfunc realGo() {}\n",
    "e.java": "// class HiddenJava {}\nclass RealJava {}\n",
  });
  await index.build();
  assert.deepEqual(index.search("", 100).map(s => s.name).sort(), ["RealJava", "RealRuby", "realGo", "realPhp", "realPy"].sort());
});

test("indexer W3: opaque template literals and docstrings cannot leak commented or example declarations", async (t) => {
  const { index } = fixture(t, {
    "template.ts": [
      'const example = `',
      'class ExampleInText {}',
      '${(() => {',
      '  // function hiddenInInterpolation() {}',
      '  return 1;',
      '})()}',
      '`;',
      'export function afterTemplate() {}',
    ].join('\n'),
    "doc.py": '"""\ndef example_in_docstring():\n    pass\n"""\ndef after_docstring():\n    pass\n',
  });
  await index.build();
  assert.deepEqual(index.search("", 100).map(s => s.name), ["afterTemplate", "after_docstring"]);
});

test("indexer W4: method patterns cover JS/TS aliases without treating ordinary calls as methods", async (t) => {
  const files: Record<string, string> = {};
  for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs"]) {
    files[`methods.${ext}`] = [
      "class Client {",
      "  async run() {}",
      "  static create() {}",
      "  get state() { return 1; }",
      "  set state(value) {}",
      "  *entries() { yield 1; }",
      "  private async request<T>(value: T) { return value; }",
      "}",
      "  request(1);",
    ].join("\n");
  }
  const { index } = fixture(t, files);
  await index.build();
  assert.equal(index.search("request", 100).length, 6);
  assert.equal(index.search("entries", 100).length, 6);
  assert.ok(index.search("run", 100).every(s => s.kind === "method"));
  assert.equal(index.search("state", 100).length, 12);
});

test("indexer A5/A6: real LLMClient methods replace phantom local-variable anchors", async (t) => {
  const source = fs.readFileSync(path.resolve("src/llm.ts"), "utf8");
  const { index } = fixture(t, { "llm.ts": source });
  await index.build();
  for (const name of ["post", "summarize", "anthropicStream"]) {
    assert.ok(index.search(name).some(s => s.name === name && s.path === "llm.ts" && s.kind === "method"), name);
  }
  for (const name of ["url", "u", "delta", "body"]) {
    assert.ok(!index.search(name, 100).some(s => s.name === name && s.kind === "function"), name);
  }
});

test("indexer W5: same-line arrows require an actual arrow; multiline parameter lists remain a documented miss", async (t) => {
  const { index } = fixture(t, { "arrows.ts": [
    "const url = (config as Config).url;",
    "const u = (evt as any).usage;",
    "const delta = (evt as any).choices[0];",
    "const body = (await response.text()).slice(0, 500);",
    "const plain = (x: number) => x;",
    "let typed = (x: number): number => x;",
    "const asynchronous = async (x: number): Promise<number> => x;",
    "const multiline = (",
    "  x: number,",
    ") => x;",
  ].join("\n") });
  await index.build();
  assert.deepEqual(index.search("", 100).map(s => s.name), ["asynchronous", "plain", "typed"]);
});

test("indexer W3: comments cannot introduce edges or imports, while a quoted import remains", async (t) => {
  const { index, dbPath } = fixture(t, {
    "target.ts": "export function target() {}\n",
    "caller.ts": [
      'import { target } from "./target.js";',
      '// import { ghost } from "./ghost.js";',
      "export function caller() {",
      "  // target();",
      "  /* target(); */",
      "  target();",
      "}",
    ].join("\n"),
  });
  await index.build();
  assert.deepEqual(index.whoCalls("target").map(e => e.line), [6]);
  assert.deepEqual(index.callsFrom("caller").map(e => e.callee), ["target"]);
  const db = new DatabaseSync(dbPath);
  try { assert.deepEqual(db.prepare("SELECT target FROM imports").all().map(r => r.target), ["./target.js"]); }
  finally { db.close(); }
});

test("indexer A3: repoMap groups by name, counts each edge once per direction, and flags multiple files", async (t) => {
  const { index } = fixture(t, {
    "a.ts": "export function repeated() { return left(); }\nfunction left() {}\n",
    "b.ts": "export function repeated() { return right(); }\nfunction right() {}\n",
    "main.ts": "export function entry() { return repeated(); }\n",
  });
  await index.build();
  const map = index.repoMap(100).split("\n");
  const names = map.map(line => line.split(" ")[0]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(map.includes("repeated [function] 2 files (ambiguous) (3 connections)"));
  assert.ok(map.includes("entry [function] main.ts (1 connections)"));
  assert.equal(index.repoMap(1), map[0]);
});

test("indexer W1: refresh atomically rolls back removals, pass-1 writes, edges, imports and mtimes", async (t) => {
  const { index, dbPath, root, write } = fixture(t, {
    "keep.ts": 'import { old } from "./old.js";\nexport function keep() { return old(); }\n',
    "old.ts": "export function old() {}\n",
  });
  await index.build();
  const db = new DatabaseSync(dbPath);
  try {
    const snapshot = () => ["symbols", "edges", "imports", "call_refs", "files", "meta"].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    write("keep.ts", 'import { added } from "./added.js";\nexport function keep() { return added(); }\n');
    write("added.ts", "export function added() {}\n");
    fs.unlinkSync(path.join(root, "old.ts"));
    db.exec("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    await assert.rejects(() => index.refresh(), /test rollback/);
    assert.deepEqual(snapshot(), before);
    db.exec("DROP TRIGGER fail_edge");
    assert.equal((await index.refresh()).files, 2);
    assert.equal(index.search("old").length, 0);
    assert.deepEqual(index.callsFrom("keep").map(e => e.callee), ["added"], "pass 2 sees new symbols from pass 1");
    assert.equal((await index.refresh()).files, 0);
    assert.ok(index.isBuilt());
  } finally { db.close(); }
});

test("indexer: refresh reparses pre-fix caches once without requiring source mtime changes", async (t) => {
  const { index, dbPath } = fixture(t, {
    "existing.ts": "class Base {}\nconst a = new class extends Base {};\n",
  });
  await index.build();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DELETE FROM meta WHERE key='parser_version'");
    db.prepare("INSERT INTO symbols (name,kind,path,line,signature) VALUES (?, ?, ?, ?, ?)").run("extends", "class", "existing.ts", 2, "legacy phantom");
    assert.equal(index.search("extends").length, 1);
    assert.equal((await index.refresh()).files, 1);
    assert.equal(index.search("extends").length, 0);
    assert.equal((await index.refresh()).files, 0);
  } finally { db.close(); }
});

test("indexer A9: import binding removes the false chain and preserves the real path", async (t) => {
  const { index } = fixture(t, {
    "a/parser.ts": 'export function parse(input: string) { return validate(input.split(",")); }\nfunction validate(rows: string[]) { return rows; }\n',
    "b/config.ts": "export function parse(raw: string) { return freeze({ raw }); }\nfunction freeze(o: object) { return Object.freeze(o); }\n",
    "main.ts": 'import { parse } from "./a/parser.js";\nexport function loadCsv(text: string) { return parse(text); }\n',
  }, true);
  await index.build();
  assert.equal(index.tracePath("loadCsv", "freeze"), undefined);
  assert.deepEqual(index.tracePath("loadCsv", "validate"), ["loadCsv", "parse", "validate"]);
  assert.equal(index.callsFrom("loadCsv")[0]?.path, "main.ts");
  assert.equal(index.callsFrom("loadCsv")[0]?.callee_path, path.join("a", "parser.ts"));
  assert.throws(() => index.callsFrom("parse"), /Ambiguous symbol/);
  assert.throws(() => index.whoCalls("parse"), /Ambiguous symbol/);
  const b = index.search("parse").find(s => s.path === path.join("b","config.ts"))!;
  assert.ok(index.callsFrom(b.id).some(e => e.callee === "freeze"));
  assert.match(index.repoMap(), /parse \[function\] 2 files \(ambiguous\)/);
});

// Release invariant: compare canonical facts, excluding rowids and volatile meta.
// The independent clean build is a test oracle; refresh must not rebuild at runtime.
function canonicalGraph(db: DatabaseSync) {
  return Object.fromEntries([
    ["symbols", "path, line, name, kind, signature"],
    ["edges", "path, line, caller, callee"],
    ["imports", "src, line, target"],
    ["call_refs", "path, line, caller, callee"],
    ["files", "path"],
    ["analysis_files", "path"],
  ].map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
}

async function assertCleanGraph(root: string, dbPath: string, label: string, semantic = false) {
  const cleanPath = path.join(root, ".clean.db");
  const clean = new CodeIndexer(cleanPath, root, { providers: false, typescript: semantic ? compiler : false });
  const actual = new DatabaseSync(dbPath);
  const expected = new DatabaseSync(cleanPath);
  try {
    await clean.build();
    assert.deepEqual(canonicalGraph(actual), canonicalGraph(expected), label);
  } finally { actual.close(); expected.close(); clean.close(); }
}

test("indexer release invariant: additions, deletions, renames and export changes equal a clean build", async (t) => {
  const { index, root, dbPath, write } = fixture(t, {
    "main.ts": 'import { later } from "./provider.js";\nexport function caller() { later(); later(); renamed(); }\n',
  });
  await index.build();
  await assertCleanGraph(root, dbPath, "initial unresolved calls");
  assert.equal(index.callsFrom("caller").length, 0);
  const refresh = async (label: string, changedFiles: number) => {
    assert.equal((await index.refresh()).files, changedFiles, label);
    await assertCleanGraph(root, dbPath, label);
  };

  write("provider.ts", "export function later() { return leaf(); }\nfunction leaf() {}\n");
  await refresh("add a definition without touching its caller", 1);
  assert.equal(index.whoCalls("later").length, 2, "preserve two distinct call occurrences");
  fs.unlinkSync(path.join(root, "provider.ts"));
  await refresh("remove a definition without touching its caller", 0);
  assert.equal(index.whoCalls("later").length, 0);

  write("provider.ts", "export function later() { return leaf(); }\nfunction leaf() {}\n");
  await refresh("restore a definition and rediscover its callers", 1);
  fs.mkdirSync(path.join(root, "nested"));
  fs.renameSync(path.join(root, "provider.ts"), path.join(root, "nested", "provider.ts"));
  await refresh("rename a definition file", 1);
  assert.equal(index.callsFrom("later")[0]?.path, path.join("nested", "provider.ts"));

  write("nested/provider.ts", "export function renamed() { return leaf(); }\nfunction leaf() {}\n");
  await refresh("rename an exported definition", 1);
  assert.equal(index.whoCalls("later").length, 0);
  assert.equal(index.whoCalls("renamed").length, 1);
  write("nested/provider.ts", "function renamed() { return leaf(); }\nfunction leaf() {}\n");
  await refresh("remove the export modifier", 1);
  // Visibility/import scoping remains W7: both fresh and incremental graphs are name-based.
  assert.equal(index.whoCalls("renamed").length, 1);
  write("barrel.ts", 'export { renamed } from "./nested/provider.js";\n');
  await refresh("add a re-export", 1);
  write("barrel.ts", 'export * from "./other.js";\n');
  await refresh("change a re-export target", 1);

  fs.renameSync(path.join(root, "main.ts"), path.join(root, "entry.ts"));
  await refresh("rename a caller file", 1);
  assert.equal(index.whoCalls("renamed")[0]?.path, "entry.ts");
  fs.unlinkSync(path.join(root, "entry.ts"));
  await refresh("delete the caller and its unresolved references", 0);
  write("nested/provider.ts", "export function later() {}\n");
  await refresh("a deleted caller cannot reappear when a definition returns", 1);
  assert.equal(index.whoCalls("later").length, 0);
  await refresh("no changes", 0);
});

test("indexer: only removing the last same-named definition invalidates cached calls", async (t) => {
  const { index, root, dbPath, write } = fixture(t, {
    "main.ts": "export function caller() { return target(); }\n",
    "one.ts": "export function target() {}\n",
    "two.ts": "export function target() {}\n",
  });
  await index.build();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TRIGGER protect_caller BEFORE DELETE ON call_refs WHEN OLD.path = 'main.ts' BEGIN SELECT RAISE(ABORT, 'unchanged caller reparsed'); END");
    fs.unlinkSync(path.join(root, "one.ts"));
    assert.equal((await index.refresh()).files, 0);
    assert.equal(index.whoCalls("target").length, 1);
    await assertCleanGraph(root, dbPath, "one definition remains");
    fs.unlinkSync(path.join(root, "two.ts"));
    await index.refresh();
    assert.equal(index.whoCalls("target").length, 0);
    await assertCleanGraph(root, dbPath, "last definition removed");
    write("three.ts", "function target() {}\n");
    assert.equal((await index.refresh()).files, 1);
    assert.equal(index.whoCalls("target").length, 1);
    await assertCleanGraph(root, dbPath, "definition restored without reparsing the caller");
  } finally { db.close(); }
});

test("indexer: unresolved references survive closing and reopening the index", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faber-indexer-reopen-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, ".index.db");
  fs.writeFileSync(path.join(root, "main.ts"), "export function caller() { return future(); }\n");
  const first = new CodeIndexer(dbPath, root, { providers: false });
  try { await first.build(); } finally { first.close(); }
  fs.writeFileSync(path.join(root, "future.ts"), "export function future() {}\n");
  const reopened = new CodeIndexer(dbPath, root, { providers: false });
  try {
    assert.equal((await reopened.refresh()).files, 1);
    assert.deepEqual(reopened.whoCalls("future").map(e => e.caller), ["caller"]);
    await assertCleanGraph(root, dbPath, "persistent unresolved reference");
  } finally { reopened.close(); }
});

test("indexer: legacy databases populate the reference cache once and retain their graph tables", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "faber-indexer-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "main.ts");
  const dbPath = path.join(root, ".index.db");
  fs.writeFileSync(file, "export function caller() { return future(); }\n");
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec("CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ms REAL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    legacy.prepare("INSERT INTO files VALUES (?, ?)").run("main.ts", fs.statSync(file).mtimeMs);
    legacy.exec("INSERT INTO meta VALUES ('parser_version', '1'), ('built_at', '1')");
  } finally { legacy.close(); }
  const index = new CodeIndexer(dbPath, root, { providers: false });
  try {
    assert.equal((await index.refresh()).files, 1);
    assert.equal((await index.refresh()).files, 0);
    fs.writeFileSync(path.join(root, "future.ts"), "function future() {}\n");
    assert.equal((await index.refresh()).files, 1);
    assert.equal(index.whoCalls("future").length, 1);
    await assertCleanGraph(root, dbPath, "upgraded reference cache");
  } finally { index.close(); }
});

test("indexer: no-change refresh does not rewrite graph facts or metadata", async (t) => {
  const { index, dbPath } = fixture(t, { "main.ts": "function main() { return missing(); }\n" });
  await index.build();
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of ["symbols", "edges", "imports", "call_refs", "files", "meta"]) {
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER forbid_${table}_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'no-change write'); END`);
      }
    }
    assert.deepEqual((await index.refresh()), { files: 0, symbols: 1, edges: 0 });
  } finally { db.close(); }
});

test("indexer: equal-size edits with preserved mtimes are detected by change time", async (t) => {
  const { index, root, dbPath } = fixture(t, {
    "main.ts": "function main() { aaaa(); bbbb(); }\n",
    "target.ts": "export function aaaa() {}\n",
  });
  const file = path.join(root, "target.ts");
  const stamp = 1_700_000_000;
  fs.utimesSync(file, stamp, stamp);
  await index.build();
  const before = fs.statSync(file);
  fs.writeFileSync(file, "export function bbbb() {}\n");
  fs.utimesSync(file, stamp, stamp);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal((await index.refresh()).files, 1);
  assert.equal(index.whoCalls("aaaa").length, 0);
  assert.equal(index.whoCalls("bbbb").length, 1);
  await assertCleanGraph(root, dbPath, "preserved mtime export edit");
});

test("indexer: a failed rebuild rolls back all graph and cache facts", async (t) => {
  const { index, dbPath, write } = fixture(t, {
    "main.ts": "function main() { return target(); }\n",
    "target.ts": "function target() {}\n",
  });
  await index.build();
  const db = new DatabaseSync(dbPath);
  try {
    const before = canonicalGraph(db);
    write("target.ts", "export function target() {}\n");
    db.exec("CREATE TRIGGER fail_build BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'rebuild failure'); END");
    await assert.rejects(() => index.build(), /rebuild failure/);
    assert.deepEqual(canonicalGraph(db), before);
    db.exec("DROP TRIGGER fail_build");
    assert.equal((await index.refresh()).files, 1);
    await assertCleanGraph(path.dirname(dbPath), dbPath, "retry after failed rebuild");
  } finally { db.close(); }
});

test("indexer: file deletion and reference resolution use indexed lookups", (t) => {
  const { dbPath } = fixture(t, {});
  const db = new DatabaseSync(dbPath);
  try {
    for (const [table, column] of [["symbols", "path"], ["edges", "path"], ["imports", "src"], ["call_refs", "path"], ["call_refs", "callee"]]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE ${column} = ?`).all("example");
      assert.ok(plan.some(row => /SEARCH .* USING .*INDEX/.test(String(row.detail))), `${table}.${column}: ${JSON.stringify(plan)}`);
      assert.ok(plan.every(row => !/SCAN/.test(String(row.detail))), `${table}.${column}`);
    }
  } finally { db.close(); }
});

// Semantic regression cases: positive paths are asserted alongside rejected paths.
test("indexer: qualified scopes separate class methods, shadowing and callback bodies", async (t) => {
  const {index,dbPath}=fixture(t,{
    "main.ts":[
      "function left() {} function right() {}",
      "export class A { parse() { left(); } }",
      "export class B { parse() { right(); } }",
      "export function entry() { new A().parse(); }",
      "function finished() { left(); }",
      "right();",
      "function outer() { function left() {} left(); const cb = () => right(); cb(); }",
      "function invoke(left: () => void) { left(); }",
    ].join("\n"),
  },true);
  await index.build();
  assert.deepEqual(index.callsFrom("A.parse").map(e=>e.callee),["left"]);
  assert.deepEqual(index.callsFrom("B.parse").map(e=>e.callee),["right"]);
  assert.throws(()=>index.callsFrom("parse"),/Ambiguous/);
  assert.equal(index.tracePath("entry","right"),undefined);
  const left=index.search("left").find(s=>s.qualified==="left")!;
  assert.deepEqual(index.tracePath("entry",left.id),["entry","parse","left"]);
  assert.equal(index.trace("entry",left.id,1).status,"incomplete");
  assert.deepEqual(index.callsFrom("finished").map(e=>e.callee),["left"]);
  assert.equal(index.callsFrom("outer").find(e=>e.callee==="left")?.callee_id,index.search("outer.left")[0]?.id);
  assert.deepEqual(index.callsFrom("outer.cb").map(e=>e.callee),["right"]);
  assert.equal(index.referencesFrom("invoke")[0]?.status,"indirect");
  const db=new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT caller FROM call_refs WHERE line=6").get()?.caller,"<module>");
    assert.equal(db.prepare("SELECT COUNT(DISTINCT id) c FROM symbols WHERE name='parse'").get()?.c,2);
  } finally {db.close();}
});

test("indexer: contracts, overloads, generators and multiline arrows retain honest binding status",async(t)=>{
  const {index}=fixture(t,{"main.ts":[
    "export interface Worker { run(): void; }",
    "export function drive(w: Worker) { w.run(); }",
    "export class Base { step() {} run() { this.step(); } }",
    "export class Derived extends Base { override step() {} }",
    "export function overloaded(x: string): string;",
    "export function overloaded(x: number): number;",
    "export function overloaded(x: any) { return x; }",
    "export function entry() { overloaded(1); multi(1); }",
    "const multi = (",
    "  n: number,",
    ") => overloaded(n);",
    "export class Collection { *entries() {} *values() {} *keys() {} }",
    "let mutable = () => overloaded(1);",
    "export function invokeMutable() { mutable(); }",
  ].join("\n")},true);
  await index.build();
  assert.equal(index.referencesFrom("drive")[0]?.status,"contract");
  assert.equal(index.callsFrom("Base.run")[0]?.dispatch,"member");
  assert.equal(index.callsFrom("Base.run")[0]?.callee_id,index.search("Base.step")[0]?.id);
  assert.equal(index.search("overloaded").length,1);
  assert.ok(index.callsFrom("entry").every(e=>e.status==="resolved"));
  assert.deepEqual(index.tracePath("multi","overloaded"),["multi","overloaded"]);
  for (const name of ["entries","values","keys"]) assert.equal(index.search(name)[0]?.kind,"method");
  assert.equal(index.referencesFrom("invokeMutable")[0]?.status,"indirect");
  assert.equal(index.tracePath("invokeMutable","overloaded"),undefined);
});

test("indexer: semantic refresh equals rebuild through missing imports, barrels, export edits and restarts",async(t)=>{
  const {index,root,dbPath,write}=fixture(t,{
    "main.ts":'import { target } from "./barrel.js";\nexport function entry() { return target(); }\n',
    "barrel.ts":'export { target } from "./one.js";\n',
  },true);
  await index.build();
  assert.equal(index.referencesFrom("entry")[0]?.status,"unresolved");
  const check=async (label:string)=>{await index.refresh();await assertCleanGraph(root,dbPath,label,true);};
  write("one.ts","export function target() { return left(); }\nfunction left() {}\n");
  await check("newly available import");assert.deepEqual(index.tracePath("entry","left"),["entry","target","left"]);
  write("two.ts","export function target() { return right(); }\nfunction right() {}\n");
  await check("unrelated same-name definition");
  write("barrel.ts",'export { target } from "./two.js";\n');
  await check("barrel retargets unchanged importer");assert.deepEqual(index.tracePath("entry","right"),["entry","target","right"]);
  write("two.ts","function target() { return right(); }\nfunction right() {}\nexport {};\n");
  await check("removed export");assert.equal(index.tracePath("entry","right"),undefined);
  fs.renameSync(path.join(root,"two.ts"),path.join(root,"renamed.ts"));await check("renamed definition file");
  fs.unlinkSync(path.join(root,"one.ts"));await check("deleted definition");
  write("barrel.ts",'export { target } from "./renamed.js";\n');
  write("renamed.ts","export function target() { return right(); }\nfunction right() {}\n");
  await check("restored export");
  const reopened=new CodeIndexer(dbPath,root,{providers:false,typescript:compiler});
  try {
    fs.unlinkSync(path.join(root,"renamed.ts"));await reopened.refresh();await assertCleanGraph(root,dbPath,"deleted through reopened cache",true);
    write("renamed.ts","export function target() { return right(); }\nfunction right() {}\n");
    await reopened.refresh();await assertCleanGraph(root,dbPath,"persistent unresolved import",true);
    assert.deepEqual(reopened.tracePath("entry","right"),["entry","target","right"]);
  } finally {reopened.close();}
});

test("indexer: config edits and newly preferred module files invalidate unchanged callers",async(t)=>{
  const {index,root,dbPath,write}=fixture(t,{
    "tsconfig.json":JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",baseUrl:".",paths:{"@impl":["./one.ts"]}}}),
    "main.ts":'import {target} from "@impl"; export function entry() { target(); }\n',
    "one.ts":"export function target() {}\n", "two.ts":"export function target() {}\n",
    "consumer.ts":'import {other} from "./foo"; export function consumer() { other(); }\n',
    "foo/index.ts":"export function other() {}\n",
  },true);
  await index.build();assert.equal(index.callsFrom("entry")[0]?.callee_path,"one.ts");
  write("tsconfig.json",JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",baseUrl:".",paths:{"@impl":["./two.ts"]}}}));
  await index.refresh();await assertCleanGraph(root,dbPath,"config-only edit",true);assert.equal(index.callsFrom("entry")[0]?.callee_path,"two.ts");
  write("foo.ts","export function other() {}\n");await index.refresh();
  await assertCleanGraph(root,dbPath,"newly preferred module",true);assert.equal(index.callsFrom("consumer")[0]?.callee_path,"foo.ts");
});

test("indexer: semantic generations are atomic and no-change refresh writes nothing",async(t)=>{
  const {index,dbPath,root,write}=fixture(t,{"main.ts":"export function entry() { leaf(); }\nfunction leaf() {}\n"},true);
  await index.build();const db=new DatabaseSync(dbPath);
  try {
    const tables=["symbols","edges","imports","call_refs","files","analysis_files","analysis_inputs","meta"];
    const snapshot=()=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before=snapshot();
    for (const table of tables) db.exec(`CREATE TRIGGER forbid_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'no-change write'); END`);
    assert.equal((await index.refresh()).files,0);assert.deepEqual(snapshot(),before);
    for (const table of tables) db.exec(`DROP TRIGGER forbid_${table}`);
    write("main.ts","export function entry() { leaf(); leaf(); }\nfunction leaf() {}\n");
    db.exec("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT,'semantic rollback'); END");
    await assert.rejects(() => index.refresh(),/semantic rollback/);assert.deepEqual(snapshot(),before);
    db.exec("DROP TRIGGER fail_edge");await index.refresh();await assertCleanGraph(root,dbPath,"retry after semantic publication failure",true);
  } finally {db.close();}
});

test("indexer: heuristic fallback cannot stitch ambiguous names into paths",async(t)=>{
  const {index}=fixture(t,{"one.ts":"function tick() { left(); }\nfunction left() {}\n","two.ts":"function tick() { right(); }\nfunction right() {}\n","main.ts":"function entry() { tick(); }\n"});
  await index.build();assert.throws(()=>index.callsFrom("tick"),/Ambiguous/);
  assert.equal(index.trace("entry","right").status,"unavailable");assert.equal(index.tracePath("entry","right"),undefined);
  assert.equal(index.referencesFrom("entry")[0]?.status,"heuristic");
});

test("indexer: incomplete and stale IDs are errors, while valid empty selections remain empty", async t => {
  const source = "class Pipeline:\n    def run(self):\n        helper()\ndef helper():\n    pass\n";
  const { index, write } = fixture(t, { "pipeline.py": source });
  await index.build();
  const pipeline = index.search("Pipeline")[0]!;
  assert.match(pipeline.id, /^heuristic:.*:Pipeline@1$/);
  assert.deepEqual(index.referencesFrom(pipeline.id), [], "a class query does not aggregate method bodies");
  assert.equal(index.referencesFrom(index.search("run")[0]!.id)[0]?.callee, "helper");
  for (const id of [pipeline.id.replace(/@\d+$/, ""), "ts:missing", "lsp:missing"]) {
    for (const query of [() => index.whoCalls(id), () => index.callsFrom(id), () => index.referencesFrom(id),
      () => index.trace(id, "helper"), () => index.callTree(id)]) {
      assert.throws(query, SymbolNotFoundError);
      assert.throws(query, /Copy a complete current id from search_code or graph_context/);
    }
  }
  assert.deepEqual(index.whoCalls("not_indexed"), [], "preserve the ordinary missing-name API");
  assert.deepEqual(index.referencesFrom(index.search("helper")[0]!.id), [], "an indexed leaf remains a valid empty result");
  write("pipeline.py", "\n" + source);
  await index.refresh();
  assert.throws(() => index.referencesFrom(pipeline.id), SymbolNotFoundError);
  const moved = index.search("Pipeline")[0]!;
  assert.notEqual(moved.id, pipeline.id);
  assert.deepEqual(index.referencesFrom(moved.id), []);
});

test("indexer: inferred return types and equal-offset location edits refresh unchanged callers",async(t)=>{
  const {index,root,dbPath,write}=fixture(t,{
    "factory.ts":"export class A { run() { left(); } }\nexport class B { run() { right(); } }\nfunction left() {}\nfunction right() {}\nexport function make() { return new A(); }\n",
    "main.ts":'import {make} from "./factory.js"; export function entry() { make().run(); }\n',
    "location.ts":"export function target() {}\n",
    "caller.ts":'import {target} from "./location.js"; export function caller() { target(); }\n',
  },true);
  await index.build();assert.ok(index.tracePath("entry","left"));
  const source=fs.readFileSync(path.join(root,"factory.ts"),"utf8");
  write("factory.ts",source.replace("return new A()","return new B()"));await index.refresh();
  await assertCleanGraph(root,dbPath,"inferred return type edit",true);assert.equal(index.tracePath("entry","left"),undefined);assert.ok(index.tracePath("entry","right"));
  write("location.ts","export\nfunction target() {}\n");await index.refresh();
  await assertCleanGraph(root,dbPath,"equal-offset new line",true);assert.equal(index.callsFrom("caller")[0]?.callee_line,1);
  // Move a whole declaration across a same-length prefix, keeping its ID/offset.
  write("location.ts","//x\nexport function target() {}\n");await index.refresh();const id=index.search("target")[0]!.id;
  write("location.ts",";\n;\nexport function target() {}\n");await index.refresh();
  assert.equal(index.search("target")[0]!.id,id);assert.equal(index.callsFrom("caller")[0]?.callee_line,3);
  await assertCleanGraph(root,dbPath,"unchanged target ID but moved line",true);
});

test("indexer: project compiler discovery and source-count guard preserve cache consistency",async(t)=>{
  const {root,dbPath,write}=fixture(t,{"main.ts":"export function entry() { leaf(); }\nfunction leaf() {}\n"});
  fs.mkdirSync(path.join(root,"node_modules"),{recursive:true});
  fs.symlinkSync(path.dirname(path.dirname(compiler)),path.join(root,"node_modules/typescript"),"dir");
  const index=new CodeIndexer(dbPath,root,{providers:false,semanticFileLimit:1});
  try {
    await index.build();assert.deepEqual(index.tracePath("entry","leaf"),["entry","leaf"]);
    write("extra.ts","export function extra() {}\n");await index.refresh();
    assert.match(index.coverage(),/exceeds the compiler file limit/);assert.equal(index.trace("entry","leaf").status,"unavailable");
    fs.unlinkSync(path.join(root,"extra.ts"));await index.refresh();assert.deepEqual(index.tracePath("entry","leaf"),["entry","leaf"]);
    await assertCleanGraph(root,dbPath,"guard mode transition",true);
  } finally {index.close();}
});

test("indexer: constructor, arrow field, decorators and initializers have distinct owners",async(t)=>{
  const {index}=fixture(t,{"main.ts":[
    "function ctor() {} function field() {} function staticInit() {} function decorates() {}",
    "function mark() { decorates(); return () => {}; }",
    "export class C {",
    "  constructor(@mark() value?: unknown) { ctor(); }",
    "  method() {}",
    "  callback = () => ctor();",
    "  value = field();",
    "  static { staticInit(); }",
    "}",
    "export function entry() { new C(); }",
  ].join("\n")},true);
  await index.build();assert.deepEqual(index.tracePath("entry","ctor"),["entry","constructor","ctor"]);
  assert.equal(index.tracePath("entry","decorates"),undefined);assert.equal(index.tracePath("entry","field"),undefined);
  assert.equal(index.search("callback").length,1);assert.equal(index.callsFrom("C.method").length,0);
  assert.deepEqual(index.callsFrom("C.callback").map(e=>e.callee),["ctor"]);
});

test("indexer: cross-project compiler contexts cannot compose a false path",async(t)=>{
  const config=(impl:string)=>JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",baseUrl:".",paths:{"@impl":[impl]}}});
  const {index}=fixture(t,{
    "a/tsconfig.json":config("./impl.ts"),"b/tsconfig.json":config("./impl.ts"),
    "a/entry.ts":'import {run} from "../b/shared.js"; export function entry() { run(); }\n',
    "a/impl.ts":"export function impl() { left(); } function left() {}\n",
    "b/shared.ts":'import {impl} from "@impl"; export function run() { impl(); }\n',
    "b/impl.ts":"export function impl() { right(); } function right() {}\n",
  },true);
  await index.build();assert.equal(index.referencesFrom("entry")[0]?.status,"cross_project");
  assert.equal(index.tracePath("entry","right"),undefined);assert.deepEqual(index.tracePath("run","right"),["run","impl","right"]);
});
