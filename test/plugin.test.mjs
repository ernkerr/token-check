import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// Runs the built plugin (code.js) against a fake Figma API, so it can be tested without Figma.
const code = fs.readFileSync(process.argv[2] ?? new URL("../code.js", import.meta.url), "utf8");
const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = (h, extra = {}) => ({ type: "SOLID", visible: true, color: hex(h), opacity: 1, boundVariables: {}, ...extra });

let resolveCalls = 0;
function makeToken(id, name, h, broken = false) {
  return { id, name, resolvedType: "COLOR", resolveForConsumer() { resolveCalls++; if (broken) throw new Error("alias to deleted variable"); return { resolvedType: "COLOR", value: { ...hex(h), a: 1 } }; } };
}

function setup({ tokens, buildPage, failVariables = false }) {
  const byId = new Map();
  let n = 0;
  const node = (type, name, props = {}, children) => {
    const nd = { id: `${++n}:0`, type, name, visible: true, removed: false, parent: null, fills: [], strokes: [], fillStyleId: "", strokeStyleId: "", resolvedVariableModes: { "c1": "light" }, ...props };
    if (children) { nd.children = children; for (const c of children) c.parent = nd; }
    byId.set(nd.id, nd);
    return nd;
  };
  const page = { type: "PAGE", id: "0:1", parent: null, selection: [], children: [] };
  page.children = buildPage(node);
  for (const c of page.children) c.parent = page;
  const ui = [], notes = [];
  let onmessage;
  const figma = {
    mixed: Symbol("mixed"),
    showUI() {},
    ui: { postMessage: (m) => ui.push(m), set onmessage(f) { onmessage = f; }, get onmessage() { return onmessage; } },
    currentPage: page,
    variables: {
      async getLocalVariablesAsync() { if (failVariables) throw new Error("boom"); return tokens; },
      setBoundVariableForPaint(paint, field, v) { return { ...paint, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } }; },
    },
    async getNodeByIdAsync(id) { return byId.get(id) || null; },
    viewport: { scrollAndZoomIntoView() {} },
    notify: (t, o) => notes.push(t),
    commitUndo() {},
  };
  const ctx = vm.createContext({ figma, __html__: "", setTimeout, console });
  vm.runInContext(code, ctx);
  return { figma, page, ui, notes, byId, send: (m) => onmessage(m) };
}

const blue = makeToken("v1", "blue", "#1E6BFF");
const coral = makeToken("v2", "coral", "#FF6B5A");
const gray = makeToken("v3", "gray/100", "#F2F2F2");
const broken = makeToken("v4", "broken", "#000000", true);
const tokens = [blue, coral, gray, broken];

// ---- 1. Page scan: what counts and what is skipped
let t = setup({ tokens, buildPage: (node) => [
  node("FRAME", "Card", { fills: [solid("#F2F2F2")] }, [
    node("RECTANGLE", "Close blue", { fills: [solid("#2070FF")] }),
    node("RECTANGLE", "Far green", { strokes: [solid("#22AA44")] }),
    node("RECTANGLE", "Already bound", { fills: [solid("#1E6BFF", { boundVariables: { color: { id: "v1" } } })] }),
    node("RECTANGLE", "Uses style", { fills: [solid("#123456")], fillStyleId: "S:abc" }),
    node("RECTANGLE", "Hidden paint", { fills: [solid("#123456", { visible: false })] }),
    node("GROUP", "Hidden group", { visible: false }, [node("RECTANGLE", "Inside hidden", { fills: [solid("#999999")] })]),
    node("INSTANCE", "Button instance", { fills: [solid("#FF6B5A")] }, [node("RECTANGLE", "Inside instance", { fills: [solid("#777777")] })]),
    node("TEXT", "Mixed text", { fills: Symbol.for("x") }),
  ]),
]});
t.figma.mixed = Symbol.for("x");
await t.send({ type: "scan", scope: "page" });
let res = t.ui.at(-1);
assert.equal(res.type, "results");
const names = res.items.map((i) => `${i.name}:${i.kind}`);
assert.equal(JSON.stringify(names.sort()), JSON.stringify(["Button instance:fill", "Card:fill", "Close blue:fill", "Far green:stroke"].sort()));
const byName = Object.fromEntries(res.items.map((i) => [i.name, i.nearest]));
assert.equal(byName["Card"].name, "gray/100"); assert.equal(byName["Card"].exact, true);
assert.equal(byName["Close blue"].name, "blue"); assert.equal(byName["Close blue"].close, true); assert.equal(byName["Close blue"].exact, false);
assert.equal(byName["Far green"].close, false);
assert.equal(byName["Button instance"].exact, true);
console.log("1 ok  page scan finds 4, skips bound/style/hidden/instance-children/mixed; broken token skipped");

// ---- 2. Snap after clicking a row (selection changes), selection scope rescans original roots
t.page.selection = [t.page.children[0]];
await t.send({ type: "scan", scope: "selection" });
assert.equal(t.ui.at(-1).scope, "selection"); assert.equal(t.ui.at(-1).items.length, 4);
const closeBlue = t.ui.at(-1).items.find((i) => i.name === "Close blue");
await t.send({ type: "select", id: closeBlue.id });
assert.equal(t.page.selection[0].name, "Close blue");
await t.send({ type: "snap", id: closeBlue.id, kind: closeBlue.kind, index: closeBlue.index });
assert.equal(t.notes.at(-1), "Snapped to the nearest token");
assert.equal(t.byId.get(closeBlue.id).fills[0].boundVariables.color.id, "v1");
assert.equal(t.ui.at(-1).items.length, 3, "rescan should cover the original selection, not just the clicked row");
console.log("2 ok  snap binds the token; rescan keeps the original selection");

// ---- 3. Far color refuses to snap
const far = t.ui.at(-1).items.find((i) => i.name === "Far green");
await t.send({ type: "snap", id: far.id, kind: far.kind, index: far.index });
assert.equal(t.notes.at(-1), "No token is close enough to snap that color");
assert.equal(t.byId.get(far.id).strokes[0].boundVariables.color, undefined);
console.log("3 ok  far color is never snapped");

// ---- 4. Bind exact matches
await t.send({ type: "fix-exact" });
assert.equal(t.notes.at(-1), "Bound 2 exact matches to tokens");
assert.equal(JSON.stringify(t.ui.at(-1).items.map((i) => i.name)), JSON.stringify(["Far green"]));
console.log("4 ok  bind exact matches binds 2, leaves the far one");

// ---- 5. Deleted layer
const g = t.byId.get(far.id); g.removed = true; t.byId.delete(far.id);
await t.send({ type: "snap", id: far.id, kind: far.kind, index: far.index });
assert.match(t.notes.at(-1), /changed since the scan/);
await t.send({ type: "select", id: far.id });
assert.match(t.notes.at(-1), /deleted/);
console.log("5 ok  deleted layer handled for snap and select");

// ---- 6. Empty selection
t.page.selection = [];
await t.send({ type: "scan", scope: "selection" });
assert.equal(t.ui.at(-1).type, "empty-selection");
console.log("6 ok  empty selection says so instead of scanning the page");

// ---- 7. Error path resets busy
t = setup({ tokens, failVariables: true, buildPage: (node) => [node("RECTANGLE", "r", { fills: [solid("#2070FF")] })] });
await t.send({ type: "scan", scope: "page" });
assert.equal(t.ui.at(-1).type, "error"); assert.match(t.notes.at(-1), /hit an error/);
console.log("7 ok  errors reported, plugin not stuck");

// ---- 8. Big page: progress + token cache
resolveCalls = 0;
t = setup({ tokens, buildPage: (node) => Array.from({ length: 20 }, (_, f) =>
  node("FRAME", `Frame ${f}`, f % 2 ? { resolvedVariableModes: { c1: "dark" } } : {}, Array.from({ length: 100 }, (_, i) => node("RECTANGLE", `r${i}`, { fills: [solid("#2070FF")] })))) });
const start = Date.now();
await t.send({ type: "scan", scope: "page" });
const progress = t.ui.filter((m) => m.type === "progress");
assert.equal(t.ui.at(-1).items.length, 2000);
assert.ok(progress.length >= 4, "progress messages");
assert.ok(resolveCalls <= tokens.length * 2, `resolve calls ${resolveCalls}`);
console.log(`8 ok  2,020 layers (2,000 colored) in ${Date.now() - start}ms, ${progress.length} progress updates, ${resolveCalls} token lookups (was ~${2020 * tokens.length})`);

// ---- 9. Overlapping clicks are ignored while busy
t = setup({ tokens, buildPage: (node) => [node("RECTANGLE", "r", { fills: [solid("#2070FF")] })] });
await Promise.all([t.send({ type: "scan", scope: "page" }), t.send({ type: "scan", scope: "page" })]);
assert.equal(t.ui.filter((m) => m.type === "results").length, 1);
console.log("9 ok  a second click during a scan is ignored");
