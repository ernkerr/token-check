// Token Check: finds solid fills and strokes that aren't tied to a design token
// (a color variable) or a color style, and can snap them to the nearest token.

figma.showUI(__html__, { width: 380, height: 520, themeColors: true });

// How far apart two colors can look (OKLab distance) and still count as the same
// token. Raise it to snap more aggressively, lower it to be stricter.
const CLOSE_ENOUGH = 0.08;

// Hand control back to Figma every this many layers, so a big page doesn't freeze it.
const BATCH = 500;

type Kind = "fill" | "stroke";
type Scope = "page" | "selection";
type Lab = [number, number, number];

const KINDS: Kind[] = ["fill", "stroke"];

interface Match {
  id: string;
  name: string;
  hex: string;
  exact: boolean;
  close: boolean;
}

interface Offender {
  id: string;
  name: string;
  kind: Kind;
  index: number;
  hex: string;
  nearest: Match | null;
}

interface TokenColor {
  token: Variable;
  hex: string;
  lab: Lab;
}

// Resolved token colors, keyed by variable mode. Layers in the same modes see the
// same values, so each token is resolved once per mode instead of once per layer.
type TokenCache = Map<string, TokenColor[]>;

const paintKey = (kind: Kind) => (kind === "fill" ? "fills" : "strokes");
const styleKey = (kind: Kind) => (kind === "fill" ? "fillStyleId" : "strokeStyleId");
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function toHex(c: RGB): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => ("0" + Math.round(v * 255).toString(16)).slice(-2))
      .join("")
      .toUpperCase()
  );
}

// OKLab measures distance the way eyes see it, so "nearest" means "looks closest",
// not "closest RGB numbers".
function toOklab(c: RGB): Lab {
  const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const r = linear(c.r);
  const g = linear(c.g);
  const b = linear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: Lab, b: Lab): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function isInsideInstance(node: BaseNode): boolean {
  // Colors inside an instance belong to its main component, so fix them there.
  let parent = node.parent;
  while (parent) {
    if (parent.type === "INSTANCE") return true;
    parent = parent.parent;
  }
  return false;
}

function readPaints(node: SceneNode, kind: Kind): ReadonlyArray<Paint> | null {
  const key = paintKey(kind);
  if (!(key in node)) return null;
  const paints = (node as unknown as Record<string, unknown>)[key];
  // Text with several colors in one layer comes back as figma.mixed; skip it for now.
  if (paints === figma.mixed || !Array.isArray(paints)) return null;
  return paints as ReadonlyArray<Paint>;
}

function usesColorStyle(node: SceneNode, kind: Kind): boolean {
  const id = (node as unknown as Record<string, unknown>)[styleKey(kind)];
  return typeof id === "string" && id !== "";
}

function modesKey(node: SceneNode): string {
  try {
    const modes = node.resolvedVariableModes;
    return Object.keys(modes)
      .sort()
      .map((collection) => collection + "=" + modes[collection])
      .join(",");
  } catch (error) {
    return node.id;
  }
}

function tokenColors(node: SceneNode, tokens: Variable[], cache: TokenCache): TokenColor[] {
  const key = modesKey(node);
  const cached = cache.get(key);
  if (cached) return cached;
  const colors: TokenColor[] = [];
  for (const token of tokens) {
    try {
      const resolved = token.resolveForConsumer(node);
      if (resolved.resolvedType !== "COLOR") continue;
      const value = resolved.value as RGBA;
      colors.push({ token, hex: toHex(value), lab: toOklab(value) });
    } catch (error) {
      // A token that can't be resolved (say, an alias to a deleted variable) is skipped.
    }
  }
  cache.set(key, colors);
  return colors;
}

function nearestToken(color: RGB, colors: TokenColor[]): Match | null {
  const lab = toOklab(color);
  let best: TokenColor | null = null;
  let bestDistance = Infinity;
  for (const candidate of colors) {
    const d = distance(lab, candidate.lab);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  if (!best) return null;
  const exact = best.hex === toHex(color);
  return { id: best.token.id, name: best.token.name, hex: best.hex, exact, close: exact || bestDistance <= CLOSE_ENOUGH };
}

function checkNode(node: SceneNode, tokens: Variable[], cache: TokenCache, offenders: Offender[]) {
  for (const kind of KINDS) {
    const paints = readPaints(node, kind);
    if (!paints || usesColorStyle(node, kind)) continue;
    paints.forEach((paint, index) => {
      if (paint.type !== "SOLID" || paint.visible === false) return;
      if (paint.boundVariables && paint.boundVariables.color) return;
      offenders.push({
        id: node.id,
        name: node.name,
        kind,
        index,
        hex: toHex(paint.color),
        nearest: nearestToken(paint.color, tokenColors(node, tokens, cache)),
      });
    });
  }
}

async function scan(roots: ReadonlyArray<SceneNode>): Promise<{ offenders: Offender[]; tokens: Variable[] }> {
  const tokens = await figma.variables.getLocalVariablesAsync("COLOR");
  const cache: TokenCache = new Map();
  const offenders: Offender[] = [];
  const stack = roots.slice().reverse();
  let seen = 0;
  while (stack.length > 0) {
    const node = stack.pop() as SceneNode;
    // The file can change while we pause, so skip layers deleted in the meantime.
    // Hidden layers are skipped along with everything inside them.
    if (node.removed || node.visible === false) continue;
    seen++;
    if (seen % BATCH === 0) {
      figma.ui.postMessage({ type: "progress", seen });
      await pause();
      if (node.removed) continue;
    }
    checkNode(node, tokens, cache, offenders);
    if (node.type !== "INSTANCE" && "children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return { offenders, tokens };
}

type SnapResult = "snapped" | "changed" | "far";

async function snap(target: { id: string; kind: Kind; index: number }, tokens: Variable[], cache: TokenCache): Promise<SnapResult> {
  const found = await figma.getNodeByIdAsync(target.id);
  if (!found || found.removed || found.type === "DOCUMENT" || found.type === "PAGE") return "changed";
  const node = found as SceneNode;
  const paints = readPaints(node, target.kind);
  const paint = paints ? paints[target.index] : undefined;
  if (!paints || !paint || paint.type !== "SOLID") return "changed";
  const match = nearestToken(paint.color, tokenColors(node, tokens, cache));
  // Never snap to a token that looks different. That would change the design.
  if (!match || !match.close) return "far";
  const token = tokens.find((t) => t.id === match.id);
  if (!token) return "changed";
  const next = paints.slice();
  next[target.index] = figma.variables.setBoundVariableForPaint(paint, "color", token);
  (node as unknown as Record<string, unknown>)[paintKey(target.kind)] = next;
  return "snapped";
}

// What the last scan covered, so a rescan after a snap checks the same layers even
// though clicking a row changes the selection.
let lastScope: Scope = "page";
let lastRootIds: string[] = [];

function currentRoots(scope: Scope): ReadonlyArray<SceneNode> {
  if (scope === "page") return figma.currentPage.children;
  return figma.currentPage.selection.filter((node) => !isInsideInstance(node));
}

async function lastRoots(): Promise<ReadonlyArray<SceneNode>> {
  if (lastScope === "page") return figma.currentPage.children;
  const roots: SceneNode[] = [];
  for (const id of lastRootIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && !node.removed && node.type !== "DOCUMENT" && node.type !== "PAGE") roots.push(node as SceneNode);
  }
  return roots;
}

async function report(scope: Scope, roots: ReadonlyArray<SceneNode>) {
  const { offenders, tokens } = await scan(roots);
  figma.ui.postMessage({ type: "results", items: offenders, tokenCount: tokens.length, scope });
}

let busy = false;

figma.ui.onmessage = async (msg) => {
  if (msg.type === "select") {
    const node = await figma.getNodeByIdAsync(msg.id);
    if (node && !node.removed && node.type !== "DOCUMENT" && node.type !== "PAGE") {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    } else {
      figma.notify("That layer was deleted. Scan again to refresh the list.");
    }
    return;
  }

  if (busy) return;
  busy = true;
  try {
    if (msg.type === "scan") {
      const scope = msg.scope as Scope;
      const roots = currentRoots(scope);
      if (scope === "selection" && roots.length === 0) {
        figma.ui.postMessage({ type: "empty-selection" });
        return;
      }
      lastScope = scope;
      lastRootIds = roots.map((node) => node.id);
      await report(scope, roots);
    }

    if (msg.type === "snap") {
      const tokens = await figma.variables.getLocalVariablesAsync("COLOR");
      const result = await snap(msg, tokens, new Map());
      figma.commitUndo();
      figma.notify(
        result === "snapped"
          ? "Snapped to the nearest token"
          : result === "far"
            ? "No token is close enough to snap that color"
            : "That layer changed since the scan. Scan again to refresh the list."
      );
      await report(lastScope, await lastRoots());
    }

    if (msg.type === "fix-exact") {
      // Only binds colors that already match a token exactly, so nothing changes visually.
      const roots = await lastRoots();
      const { offenders, tokens } = await scan(roots);
      const cache: TokenCache = new Map();
      let fixed = 0;
      for (const o of offenders) {
        if (o.nearest && o.nearest.exact && (await snap(o, tokens, cache)) === "snapped") fixed++;
      }
      figma.commitUndo();
      figma.notify(`Bound ${fixed} exact ${fixed === 1 ? "match" : "matches"} to tokens`);
      await report(lastScope, roots);
    }
  } catch (error) {
    figma.notify("Token Check hit an error: " + String(error), { error: true });
    figma.ui.postMessage({ type: "error" });
  } finally {
    busy = false;
  }
};
