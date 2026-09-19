// Minimal DXF (ASCII, R12-and-up group-code format) reader for the "Import Drawing" map background
// (see tag-steering-simulator.jsx's handleLoadMapImage / SVG_UNIT_TO_M). Unlike the SVG import path
// (which just inlines the file's own markup untouched), DXF has no native web rendering, so this
// module parses entities into plain world-space shape descriptions that the component renders as
// ordinary SVG elements — same toScreen() pipeline as every other geometry in the app, not a second
// rendering mechanism.
//
// Supported entities: LINE, ARC, CIRCLE, LWPOLYLINE (straight and bulge/arc segments, open or
// closed), and HATCH limited to solid fill with boundary loops that are either a single polyline-type
// loop or an edge-type loop made only of line/arc edges (the common, simple "fill this closed shape"
// case). Anything else (SPLINE edges/entities, multi-loop HATCH with islands, TEXT, 3D entities, POLYLINE/
// VERTEX's older pre-LWPOLYLINE form, blocks/inserts) is skipped with a console.warn rather than
// mis-rendered — deliberately not a general CAD-file renderer, just enough for site-plan-style drawings.
//
// Colour resolution, in order: the entity's own true-colour (group 420, 24-bit RGB) > the entity's own
// ACI colour (group 62, when not BYLAYER=256/BYBLOCK=0) > its layer's ACI colour (from the TABLES/LAYER
// section) > a grey fallback. See ACI_RGB for why only the 9 standard low indices are exact.

// The 9 standard AutoCAD Color Index entries everyone actually draws with in practice (and the ones
// every DXF-writing tool agrees on) — indices 10-255 follow AutoCAD's own HSV-ish palette, which isn't
// safe to reproduce here from memory without risking silently-wrong colours, so those fall back to a
// neutral grey ramp instead of a fabricated "exact" value.
const ACI_RGB_EXACT = {
  1: "#ff0000", 2: "#ffff00", 3: "#00ff00", 4: "#00ffff", 5: "#0000ff",
  6: "#ff00ff", 7: "#ffffff", 8: "#414141", 9: "#808080",
};
function aciToRgb(aci) {
  const i = Math.abs(aci);
  if (ACI_RGB_EXACT[i]) return ACI_RGB_EXACT[i];
  if (i === 0 || i === 256) return "#c8c8c8"; // BYBLOCK/BYLAYER with nothing else to resolve against
  const g = 60 + ((i * 37) % 140); // deterministic-but-arbitrary grey spread, not a real ACI lookup
  return `rgb(${g},${g},${g})`;
}
function trueColorToRgb(v) {
  const n = Number(v) >>> 0;
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

// ---------- group-code tokenizer ----------
// DXF alternates a group-code line and a value line. Returns [[codeNum, valueStr], ...] in order —
// order matters for entities like LWPOLYLINE/HATCH where repeated codes (10/20/42) form a vertex
// stream, so this deliberately isn't collapsed into a {code: value} map at this stage.
function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!isFinite(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

function findSectionStart(pairs, name) {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 2 && pairs[i][1] === name) return i;
  }
  return -1;
}

// Splits a section's pairs into per-record arrays, each starting at a group-code-0 line, stopping at
// ENDSEC/ENDTAB. Used for both TABLES/LAYER records and ENTITIES entities — same DXF record shape.
function splitRecords(pairs, start, stopValues) {
  const records = [];
  let cur = null;
  for (let i = start; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      if (stopValues.includes(value)) { if (cur) records.push(cur); break; }
      if (cur) records.push(cur);
      cur = { type: value, pairs: [] };
    } else if (cur) {
      cur.pairs.push([code, value]);
    }
  }
  return records;
}

function firstVal(pairs, code, fallback) {
  for (const [c, v] of pairs) if (c === code) return v;
  return fallback;
}

// ---------- layer colour table ----------
function parseLayerColors(pairs) {
  const layers = {};
  const tablesStart = findSectionStart(pairs, "TABLES");
  if (tablesStart < 0) return layers;
  // Find the LAYER table specifically (TABLES holds several tables — VPORT, LTYPE, LAYER, ...).
  let layerTableStart = -1;
  for (let i = tablesStart; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === "TABLE") {
      const nameAt = i + 1;
      if (pairs[nameAt] && pairs[nameAt][0] === 2 && pairs[nameAt][1] === "LAYER") { layerTableStart = i; break; }
    }
    if (pairs[i][0] === 0 && pairs[i][1] === "ENDSEC") break;
  }
  if (layerTableStart < 0) return layers;
  const records = splitRecords(pairs, layerTableStart + 1, ["ENDTAB"]);
  for (const rec of records) {
    if (rec.type !== "LAYER") continue;
    const name = firstVal(rec.pairs, 2, null);
    const aci = parseInt(firstVal(rec.pairs, 62, "7"), 10);
    if (name != null) layers[name] = isFinite(aci) ? aci : 7;
  }
  return layers;
}

function resolveColor(entPairs, layer, layerColors) {
  const trueColor = firstVal(entPairs, 420, null);
  if (trueColor != null) return trueColorToRgb(trueColor);
  const aci = parseInt(firstVal(entPairs, 62, "256"), 10);
  if (isFinite(aci) && aci !== 256 && aci !== 0) return aciToRgb(aci);
  const layerAci = layerColors[layer];
  if (layerAci != null) return aciToRgb(layerAci);
  return "#c8c8c8";
}

// ---------- bulge (DXF's compact way of encoding an arc segment in a polyline) ----------
// bulge = tan(includedAngle/4), sign gives direction (CCW positive). Returns null for a straight
// segment (bulge 0), otherwise {center, r, midpoint} in the SAME raw coordinate space as p0/p1, so
// callers can sample start/mid/end points without ever computing an angle in a different frame.
function bulgeArc(p0, p1, bulge) {
  if (!bulge) return null;
  const theta = 4 * Math.atan(bulge);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return null;
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const sagittaDir = bulge >= 0 ? 1 : -1; // perpendicular offset direction for the bulge's sign
  const h = r * Math.cos(theta / 2) * sagittaDir;
  const nx = -dy / chord, ny = dx / chord; // unit normal to the chord
  const center = { x: mx - nx * h, y: my - ny * h };
  const midAngle = Math.atan2((p0.y + p1.y) / 2 - center.y, (p0.x + p1.x) / 2 - center.x);
  // Snap the raw chord-midpoint out onto the actual circle for a true arc midpoint sample.
  const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x);
  const halfTheta = theta / 2;
  const mid = { x: center.x + Math.abs(r) * Math.cos(startAngle + halfTheta), y: center.y + Math.abs(r) * Math.sin(startAngle + halfTheta) };
  return { center, r: Math.abs(r), mid };
}

// ---------- vertex-stream reader (shared by LWPOLYLINE and HATCH polyline-type boundaries) ----------
// Walks an entity's ordered (code,value) pairs and collects {x,y,bulge} vertices — code 42 (bulge)
// belongs to whichever vertex most recently opened via code 10, per the DXF spec's group-order rule.
function readVertices(entPairs) {
  const verts = [];
  let cur = null;
  for (const [code, value] of entPairs) {
    if (code === 10) { cur = { x: parseFloat(value), y: 0, bulge: 0 }; verts.push(cur); }
    else if (code === 20 && cur) cur.y = parseFloat(value);
    else if (code === 42 && cur) cur.bulge = parseFloat(value);
  }
  return verts;
}

// Flattens a vertex list (with bulges) into world shapes (a stroked/filled path already carries its
// own arc segments) — returns { points: [...sample points for bounds...], segments: [{p0,p1,bulgeArc}] }
function polylineSegments(verts, closed) {
  const segs = [];
  const n = verts.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = verts[i], p1 = verts[(i + 1) % n];
    segs.push({ p0: { x: p0.x, y: p0.y }, p1: { x: p1.x, y: p1.y }, arc: bulgeArc(p0, p1, p0.bulge) });
  }
  return segs;
}

// ---------- entity extraction (raw DXF-space, not yet transformed to world) ----------
function extractEntities(pairs, layerColors) {
  const entitiesStart = findSectionStart(pairs, "ENTITIES");
  if (entitiesStart < 0) return [];
  const records = splitRecords(pairs, entitiesStart + 1, ["ENDSEC"]);
  const shapes = [];
  const skipped = {};
  const warnSkip = (type) => { skipped[type] = (skipped[type] || 0) + 1; };

  for (const rec of records) {
    const layer = firstVal(rec.pairs, 8, "0");
    const color = resolveColor(rec.pairs, layer, layerColors);

    if (rec.type === "LINE") {
      shapes.push({ type: "line", p0: { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) }, p1: { x: parseFloat(firstVal(rec.pairs, 11, 0)), y: parseFloat(firstVal(rec.pairs, 21, 0)) }, color });
    } else if (rec.type === "CIRCLE") {
      shapes.push({ type: "circle", center: { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) }, r: parseFloat(firstVal(rec.pairs, 40, 0)), color });
    } else if (rec.type === "ARC") {
      const cx = parseFloat(firstVal(rec.pairs, 10, 0)), cy = parseFloat(firstVal(rec.pairs, 20, 0));
      const r = parseFloat(firstVal(rec.pairs, 40, 0));
      const a0 = parseFloat(firstVal(rec.pairs, 50, 0)) * Math.PI / 180;
      const a1raw = parseFloat(firstVal(rec.pairs, 51, 0)) * Math.PI / 180;
      const sweep = ((a1raw - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      shapes.push({
        type: "arc", color, r,
        center: { x: cx, y: cy },
        p0: { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
        mid: { x: cx + r * Math.cos(a0 + sweep / 2), y: cy + r * Math.sin(a0 + sweep / 2) },
        p1: { x: cx + r * Math.cos(a0 + sweep), y: cy + r * Math.sin(a0 + sweep) },
      });
    } else if (rec.type === "LWPOLYLINE") {
      const closed = (parseInt(firstVal(rec.pairs, 70, "0"), 10) & 1) === 1;
      const verts = readVertices(rec.pairs);
      if (verts.length >= 2) shapes.push({ type: "polyline", segments: polylineSegments(verts, closed), closed, filled: closed, color });
      else warnSkip("LWPOLYLINE (too few vertices)");
    } else if (rec.type === "HATCH") {
      const nLoops = parseInt(firstVal(rec.pairs, 91, "0"), 10);
      if (nLoops !== 1) { warnSkip("HATCH (multi-loop/island)"); continue; }
      // Walk the ordered pairs by hand to pull out the one boundary path's data (a HATCH's boundary
      // section reuses codes 10/20/42/72/73/92/93 with meaning that depends on the surrounding
      // context, unlike a flat entity, hence not just firstVal() lookups).
      let i = rec.pairs.findIndex(([c]) => c === 92);
      if (i < 0) { warnSkip("HATCH (no boundary path)"); continue; }
      const pathTypeFlag = parseInt(rec.pairs[i][1], 10);
      const isPolylineBoundary = (pathTypeFlag & 2) === 2;
      if (isPolylineBoundary) {
        // 93 = vertex count, 72 = has-bulge flag, then the 10/20(/42) vertex stream, 97 ends it.
        const sub = rec.pairs.slice(i + 1);
        const endAt = sub.findIndex(([c]) => c === 97);
        const vertexPairs = endAt >= 0 ? sub.slice(0, endAt) : sub;
        const verts = readVertices(vertexPairs);
        if (verts.length >= 3) shapes.push({ type: "polyline", segments: polylineSegments(verts, true), closed: true, filled: true, color });
        else warnSkip("HATCH (degenerate polyline boundary)");
      } else {
        // Edge-type boundary: 93 = edge count, then per edge 72=edge type, 1=line, 2=arc (3=ellipse,
        // 4=spline unsupported). Collect line/arc edges as polyline segments directly.
        const sub = rec.pairs.slice(i + 1);
        const segs = [];
        let ok = true;
        let j = 0;
        while (j < sub.length && sub[j][0] !== 97) {
          if (sub[j][0] === 72) {
            const edgeType = parseInt(sub[j][1], 10);
            if (edgeType === 1) {
              const x1 = parseFloat(sub[j + 1][1]), y1 = parseFloat(sub[j + 2][1]);
              const x2 = parseFloat(sub[j + 3][1]), y2 = parseFloat(sub[j + 4][1]);
              segs.push({ p0: { x: x1, y: y1 }, p1: { x: x2, y: y2 }, arc: null });
              j += 5;
            } else if (edgeType === 2) {
              const cx = parseFloat(sub[j + 1][1]), cy = parseFloat(sub[j + 2][1]);
              const r = parseFloat(sub[j + 3][1]);
              const a0 = parseFloat(sub[j + 4][1]) * Math.PI / 180, a1 = parseFloat(sub[j + 5][1]) * Math.PI / 180;
              const ccw = sub[j + 6] && sub[j + 6][0] === 73 ? sub[j + 6][1] === "1" : true;
              const sweep = ccw ? (((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI) : -(((a0 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI);
              const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
              const p1 = { x: cx + r * Math.cos(a0 + sweep), y: cy + r * Math.sin(a0 + sweep) };
              segs.push({ p0, p1, arc: { center: { x: cx, y: cy }, r, mid: { x: cx + r * Math.cos(a0 + sweep / 2), y: cy + r * Math.sin(a0 + sweep / 2) } } });
              j += sub[j + 6] && sub[j + 6][0] === 73 ? 7 : 6;
            } else { ok = false; break; }
          } else j++;
        }
        if (ok && segs.length >= 3) shapes.push({ type: "polyline", segments: segs, closed: true, filled: true, color });
        else warnSkip("HATCH (spline edge or too few edges)");
      }
    } else if (["TEXT", "MTEXT", "POLYLINE", "VERTEX", "SPLINE", "INSERT", "POINT", "3DFACE", "SOLID", "DIMENSION"].includes(rec.type)) {
      warnSkip(rec.type);
    }
  }

  const skippedTypes = Object.keys(skipped);
  if (skippedTypes.length) {
    console.warn("DXF import: skipped unsupported entities —", skippedTypes.map((t) => `${t} x${skipped[t]}`).join(", "));
  }
  return shapes;
}

function shapeBoundsPoints(shape) {
  if (shape.type === "line") return [shape.p0, shape.p1];
  if (shape.type === "circle") return [{ x: shape.center.x - shape.r, y: shape.center.y - shape.r }, { x: shape.center.x + shape.r, y: shape.center.y + shape.r }];
  if (shape.type === "arc") return [{ x: shape.center.x - shape.r, y: shape.center.y - shape.r }, { x: shape.center.x + shape.r, y: shape.center.y + shape.r }];
  if (shape.type === "polyline") return shape.segments.flatMap((s) => [s.p0, s.p1]);
  return [];
}

// world.x = unitToM*(v - anchorV); world.y = -unitToM*(u - anchorU) — "file's own up/right land as
// screen up/right, no rotation," same placement intent as the SVG import path (see
// tag-steering-simulator.jsx, SVG_UNIT_TO_M). NOT the same formula, though, and deliberately so: SVG's
// y-axis increases downward (screen convention), but DXF's y-axis increases upward (standard CAD/math
// convention) — reusing SVG's formula unmodified here was an earlier bug (mirrored top-to-bottom
// relative to any real CAD viewer, caught by testing against a real DXF); the x/y roles are swapped
// the same way for both formats (matching toScreen's own axis convention), but the v term's sign
// flips between them specifically to correct for that y-up-vs-y-down difference.
function toWorld(p, anchor, unitToM) {
  return { x: unitToM * (p.y - anchor.y), y: -unitToM * (p.x - anchor.x) };
}

// Top-level entry point: raw DXF text + the chosen unit conversion (SVG_UNIT_TO_M['mm' | 'mil'], same
// picker the SVG import path uses) -> { shapes } in WORLD-SPACE metres, ready for toScreen() each
// frame exactly like the rest of the app's geometry — no per-render unit math, unlike the SVG import
// path (which keeps re-deriving its placement transform live because it's placing untouched foreign
// markup, not shapes this app controls).
export function parseDxfToWorldShapes(text, unitToM) {
  const pairs = tokenize(text);
  if (findSectionStart(pairs, "ENTITIES") < 0) throw new Error("No ENTITIES section found — not a DXF file this importer recognises");
  const layerColors = parseLayerColors(pairs);
  const rawShapes = extractEntities(pairs, layerColors);
  if (rawShapes.length === 0) throw new Error("No supported entities found (LINE/ARC/CIRCLE/LWPOLYLINE/simple HATCH)");

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of rawShapes) {
    for (const p of shapeBoundsPoints(shape)) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  const tf = (p) => toWorld(p, anchor, unitToM);
  const worldShapes = rawShapes.map((shape) => {
    if (shape.type === "line") return { type: "line", p0: tf(shape.p0), p1: tf(shape.p1), color: shape.color };
    if (shape.type === "circle") return { type: "circle", center: tf(shape.center), r: shape.r * unitToM, color: shape.color };
    if (shape.type === "arc") return { type: "arc", center: tf(shape.center), r: shape.r * unitToM, p0: tf(shape.p0), mid: tf(shape.mid), p1: tf(shape.p1), color: shape.color };
    // polyline
    return {
      type: "polyline", closed: shape.closed, filled: shape.filled, color: shape.color,
      segments: shape.segments.map((s) => ({
        p0: tf(s.p0), p1: tf(s.p1),
        arc: s.arc ? { center: tf(s.arc.center), r: s.arc.r * unitToM, mid: tf(s.arc.mid) } : null,
      })),
    };
  });

  return { shapes: worldShapes, widthM: (maxX - minX) * unitToM, heightM: (maxY - minY) * unitToM };
}

// ---------- screen-space rendering helpers ----------
// Pure functions of a world-space shape + the caller's own toScreen()/view.scale (passed in rather
// than imported, so this module stays independent of the component) — used to build ordinary SVG
// element props, not a second rendering mechanism. Deliberately don't touch React/JSX here; the
// component maps these into <path>/<circle> elements itself.

// Arc/bulge sweep+large-arc flags derived from 3 already-known points on the arc (start/mid/end),
// never by recomputing an angle in some other coordinate frame — see toWorld()'s comment. Working
// purely in the caller's own final coordinate space (whatever toScreenFn returns) sidesteps having to
// reason about how many axis flips/reflections happened on the way there.
function arcFlags(c, p0, pm, p1) {
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  const norm = (a) => (((a - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const am = norm(Math.atan2(pm.y - c.y, pm.x - c.x));
  const a1 = norm(Math.atan2(p1.y - c.y, p1.x - c.x));
  const sweep = a1 >= am ? 1 : 0; // 1 = reaching p1 by increasing angle passes through mid first
  const totalSweep = sweep ? a1 : (2 * Math.PI - a1);
  return { large: totalSweep > Math.PI ? 1 : 0, sweep };
}

// Builds an SVG path `d` for anything except a plain circle (which the caller should render as a
// <circle> directly — no arc-flag ambiguity there since it has no start/end point).
export function dxfShapePathD(shape, toScreenFn, viewScale) {
  if (shape.type === "line") {
    const a = toScreenFn(shape.p0), b = toScreenFn(shape.p1);
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  if (shape.type === "arc") {
    const c = toScreenFn(shape.center), a = toScreenFn(shape.p0), m = toScreenFn(shape.mid), b = toScreenFn(shape.p1);
    const { large, sweep } = arcFlags(c, a, m, b);
    const r = shape.r * viewScale;
    return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweep} ${b.x} ${b.y}`;
  }
  if (shape.type === "polyline") {
    let d = "";
    shape.segments.forEach((seg, i) => {
      const a = toScreenFn(seg.p0), b = toScreenFn(seg.p1);
      if (i === 0) d += `M ${a.x} ${a.y} `;
      if (seg.arc) {
        const c = toScreenFn(seg.arc.center), m = toScreenFn(seg.arc.mid);
        const { large, sweep } = arcFlags(c, a, m, b);
        d += `A ${seg.arc.r * viewScale} ${seg.arc.r * viewScale} 0 ${large} ${sweep} ${b.x} ${b.y} `;
      } else {
        d += `L ${b.x} ${b.y} `;
      }
    });
    if (shape.closed) d += "Z";
    return d.trim();
  }
  return null; // circle
}
