// Token Check: finds solid fills and strokes that aren't tied to a design token
// (a color variable) or a color style, and can snap them to the nearest token.

figma.showUI(__html__, { width: 340, height: 480, themeColors: true });

// How far apart two colors can look (OKLab distance) and still count as the same
// token. Raise it to snap more aggressively, lower it to be stricter.
const CLOSE_ENOUGH = 0.08;

type Kind = "fill" | "stroke";
type Scope = "page" | "selection";

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

const paintKey = (kind: Kind) => (kind === "fill" ? "fills" : "strokes");
const styleKey = (kind: Kind) => (kind === "fill" ? "fillStyleId" : "strokeStyleId");

function toHex(c: RGB): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => ("0" + Math.round(v * 255).toString(16)).slice(-2))
      .join("")
      .toUpperCase()
  );
}

function sameHex(a: RGB, b: RGB): boolean {
  return toHex(a) === toHex(b);
}

// OKLab measures distance the way eyes see it, so "nearest" means "looks closest",
// not "closest RGB numbers".
function toOklab(c: RGB): [number, number, number] {
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

function distance(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
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

function collectNodes(scope: Scope): SceneNode[] {
  const selection = figma.currentPage.selection;
  const roots = scope === "selection" && selection.length > 0 ? selection : figma.currentPage.children;
  const nodes: SceneNode[] = [];
  for (const root of roots) {
    nodes.push(root);
    if ("findAll" in root) nodes.push(...root.findAll());
  }
  return nodes.filter((n) => n.visible !== false && !isInsideInstance(n));
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

function nearestToken(color: RGB, node: SceneNode, tokens: Variable[]): Match | null {
  let best: Match | null = null;
  let bestDistance = Infinity;
  for (const token of tokens) {
    const resolved = token.resolveForConsumer(node);
    if (resolved.resolvedType !== "COLOR") continue;
    const value = resolved.value as RGBA;
    const d = distance(color, value);
    if (d < bestDistance) {
      bestDistance = d;
      const exact = sameHex(color, value);
      best = { id: token.id, name: token.name, hex: toHex(value), exact, close: exact || d <= CLOSE_ENOUGH };
    }
  }
  return best;
}

async function scan(scope: Scope): Promise<{ offenders: Offender[]; tokens: Variable[] }> {
  const tokens = await figma.variables.getLocalVariablesAsync("COLOR");
  const offenders: Offender[] = [];
  for (const node of collectNodes(scope)) {
    for (const kind of ["fill", "stroke"] as Kind[]) {
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
          nearest: nearestToken(paint.color, node, tokens),
        });
      });
    }
  }
  return { offenders, tokens };
}

async function snap(target: { id: string; kind: Kind; index: number }, tokens: Variable[]): Promise<boolean> {
  const node = (await figma.getNodeByIdAsync(target.id)) as SceneNode | null;
  if (!node) return false;
  const paints = readPaints(node, target.kind);
  const paint = paints ? paints[target.index] : undefined;
  if (!paints || !paint || paint.type !== "SOLID") return false;
  const match = nearestToken(paint.color, node, tokens);
  // Never snap to a token that looks different. That would change the design.
  if (!match || !match.close) return false;
  const token = tokens.find((t) => t.id === match.id);
  if (!token) return false;
  const next = paints.slice();
  next[target.index] = figma.variables.setBoundVariableForPaint(paint, "color", token);
  (node as unknown as Record<string, unknown>)[paintKey(target.kind)] = next;
  return true;
}

let lastScope: Scope = "page";

async function report(scope: Scope) {
  lastScope = scope;
  const { offenders, tokens } = await scan(scope);
  figma.ui.postMessage({ type: "results", items: offenders, tokenCount: tokens.length, scope });
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "scan") {
    await report(msg.scope as Scope);
  }

  if (msg.type === "select") {
    const node = await figma.getNodeByIdAsync(msg.id);
    if (node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
  }

  if (msg.type === "snap") {
    const tokens = await figma.variables.getLocalVariablesAsync("COLOR");
    const ok = await snap(msg, tokens);
    figma.commitUndo();
    figma.notify(ok ? "Snapped to the nearest token" : "No token is close enough to snap that color");
    await report(lastScope);
  }

  if (msg.type === "fix-exact") {
    // Only binds colors that already match a token exactly, so nothing changes visually.
    const { offenders, tokens } = await scan(lastScope);
    let fixed = 0;
    for (const o of offenders) {
      if (o.nearest && o.nearest.exact && (await snap(o, tokens))) fixed++;
    }
    figma.commitUndo();
    figma.notify(`Bound ${fixed} exact ${fixed === 1 ? "match" : "matches"} to tokens`);
    await report(lastScope);
  }
};
