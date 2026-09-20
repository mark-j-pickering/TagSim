// Minimal DXF (ASCII, R12-and-up group-code format) reader for the "Import Drawing" map background
// (see tag-steering-simulator.jsx's handleLoadMapImage / SVG_MM_TO_M). Unlike the SVG import path
// (which just inlines the file's own markup untouched), DXF has no native web rendering, so this
// module parses entities into plain world-space shape descriptions that the component renders as
// ordinary SVG elements — same toScreen() pipeline as every other geometry in the app, not a second
// rendering mechanism.
//
// Supported entities: LINE, ARC, CIRCLE, LWPOLYLINE (straight and bulge/arc segments, open or
// closed), and HATCH limited to solid fill with boundary loops (however many — see extractEntities'
// own comment) that are each either a polyline-type loop or an edge-type loop made only of line/arc
// edges. Anything else (SPLINE edges/entities, ellipse edges, 3D entities, POLYLINE/VERTEX's older
// pre-LWPOLYLINE form, blocks/inserts) is skipped with a console.warn rather than mis-rendered —
// deliberately not a general CAD-file renderer, just enough for site-plan-style drawings.
//
// Two further, non-drawn entity kinds (see extractEntities' own comment for the exact rules):
// POINT/TEXT/MTEXT become colour "markers" consumed by polygonizeFaces() to colour an enclosed region
// found from a shared LINE/ARC network (so adjacent regions can share a boundary drawn once, never
// retraced) — a TEXT/MTEXT marker's own content, if it looks like a colour (a hex code or a plain
// word), overrides its resolved DXF colour (see colorFromLabelText), since not every CAD tool makes
// assigning an arbitrary colour to one entity easy, but typing a label always works; a LINE on a
// layer named BUS_START sets the vehicle's starting pose instead of being drawn.
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

// A TEXT/MTEXT marker's own content, if it looks like a colour, overrides its resolved DXF colour
// (see extractEntities) — hex (#f00/#ff0000) or a plain word passed straight through as a CSS colour
// keyword (the browser already knows "red"/"cornflowerblue"/etc., no name->hex table to get wrong
// here). This exists because whether a CAD tool lets you assign an arbitrary colour to one sketch
// entity varies a lot (Onshape's own DXF layers, in testing, looked like its fixed internal
// categories, not anything hand-picked) — but typing a word as a text label works everywhere.
function colorFromLabelText(text) {
  const t = (text || "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t;
  if (/^[a-z]{3,20}$/i.test(t)) return t.toLowerCase();
  return null;
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

// ---------- TABLES section: LAYER (colour/lineweight/linetype-name) and LTYPE (dash patterns) ----------
// Finds a specific named table within TABLES (which holds several — VPORT, LTYPE, LAYER, ...).
function findTable(pairs, tableName) {
  const tablesStart = findSectionStart(pairs, "TABLES");
  if (tablesStart < 0) return -1;
  for (let i = tablesStart; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === "TABLE") {
      const nameAt = i + 1;
      if (pairs[nameAt] && pairs[nameAt][0] === 2 && pairs[nameAt][1] === tableName) return i;
    }
    if (pairs[i][0] === 0 && pairs[i][1] === "ENDSEC") break;
  }
  return -1;
}

// One pass over the LAYER table for everything a layer can supply as a BYLAYER default: colour
// (group 420 true-colour, and/or group 62 ACI — a layer can carry both, same as an entity can, and
// true-colour wins when present; missing this for layers specifically — only reading entity-level
// 420 — was a real bug, see resolveColor's comment), lineweight (group 370, hundredths of a mm — see
// resolveLineweight), and linetype name (group 6, looked up in ltypeDashes — see parseLtypeDashes) —
// kept as one function/one table-scan rather than several, since it's the same records either way.
function parseLayerTable(pairs) {
  const colors = {}, trueColors = {}, lineweights = {}, linetypes = {};
  const layerTableStart = findTable(pairs, "LAYER");
  if (layerTableStart < 0) return { colors, trueColors, lineweights, linetypes };
  const records = splitRecords(pairs, layerTableStart + 1, ["ENDTAB"]);
  for (const rec of records) {
    if (rec.type !== "LAYER") continue;
    const name = firstVal(rec.pairs, 2, null);
    if (name == null) continue;
    const aci = parseInt(firstVal(rec.pairs, 62, "7"), 10);
    colors[name] = isFinite(aci) ? aci : 7;
    const trueColor = firstVal(rec.pairs, 420, null);
    if (trueColor != null) trueColors[name] = trueColor;
    const lw = parseInt(firstVal(rec.pairs, 370, ""), 10);
    if (isFinite(lw)) lineweights[name] = lw;
    const lt = firstVal(rec.pairs, 6, null);
    if (lt != null) linetypes[name] = lt;
  }
  return { colors, trueColors, lineweights, linetypes };
}

// LTYPE table: each named linetype's actual dash pattern — group 49 (repeated) gives each segment's
// length in drawing units (same raw units as coordinates, positive = pen-down/dash, negative =
// pen-up/gap, 0 = a dot), the real pattern rather than a guessed-at generic dashed look.
function parseLtypeDashes(pairs) {
  const dashes = {};
  const ltypeTableStart = findTable(pairs, "LTYPE");
  if (ltypeTableStart < 0) return dashes;
  const records = splitRecords(pairs, ltypeTableStart + 1, ["ENDTAB"]);
  for (const rec of records) {
    if (rec.type !== "LTYPE") continue;
    const name = firstVal(rec.pairs, 2, null);
    if (name == null) continue;
    const segs = rec.pairs.filter(([c]) => c === 49).map(([, v]) => parseFloat(v));
    if (segs.length) dashes[name] = segs;
  }
  return dashes;
}

// BYLAYER resolution needs the layer's true-colour checked too, not just its ACI — a layer can carry
// both (group 420 + group 62), same as an entity can, and a real DXF (all its HATCH fills BYLAYER,
// each layer's real colour only in group 420 — see parseLayerTable's comment) showed this was a real
// gap: entities resolved fine (their own 420 was already read), but anything BYLAYER fell straight to
// the layer's ACI and skipped its true-colour entirely, landing on the ACI_RGB_EXACT grey fallback
// for any index outside the 9 exact ones instead of the colour the file actually specified.
function resolveColor(entPairs, layer, layerColors, layerTrueColors) {
  const trueColor = firstVal(entPairs, 420, null);
  if (trueColor != null) return trueColorToRgb(trueColor);
  const aci = parseInt(firstVal(entPairs, 62, "256"), 10);
  if (isFinite(aci) && aci !== 256 && aci !== 0) return aciToRgb(aci);
  const layerTrue = layerTrueColors[layer];
  if (layerTrue != null) return trueColorToRgb(layerTrue);
  const layerAci = layerColors[layer];
  if (layerAci != null) return aciToRgb(layerAci);
  return "#c8c8c8";
}

// DEFAULT (-3)/unset lineweight resolves to this — most DXF-consuming viewers' own "Default" weight
// preference, not a value the spec itself mandates; 0.25mm is the common convention (AutoCAD's own
// classic default) rather than an asserted spec fact.
const LWDEFAULT_HUNDREDTHS_MM = 25;

// Same BYLAYER-fallback shape as resolveColor: entity's own group 370 (hundredths of a mm; -1 =
// BYLAYER, -2 = BYBLOCK — treated the same as BYLAYER here since blocks/inserts aren't supported, -3
// = DEFAULT) > its layer's own lineweight > LWDEFAULT_HUNDREDTHS_MM. Always returns a number, never
// null — every shape gets a real width, not just ones that happened to specify one.
function resolveLineweight(entPairs, layer, layerLineweights) {
  const raw = parseInt(firstVal(entPairs, 370, "-1"), 10);
  if (isFinite(raw) && raw >= 0) return raw;
  if (raw === -3) return LWDEFAULT_HUNDREDTHS_MM;
  const layerLw = layerLineweights[layer];
  if (layerLw != null && layerLw >= 0) return layerLw;
  return LWDEFAULT_HUNDREDTHS_MM;
}

// Same BYLAYER-fallback shape again: entity's own group 6 linetype name > its layer's own linetype
// name > "CONTINUOUS". "CONTINUOUS"/"BYLAYER"/"BYBLOCK"/unresolved names all mean "no dash pattern"
// (solid) — returns the raw dash-length array (drawing units, signed) from ltypeDashes, or null.
function resolveLinetypeDashes(entPairs, layer, layerLinetypes, ltypeDashes) {
  let name = firstVal(entPairs, 6, "BYLAYER");
  if (name === "BYLAYER" || name === "BYBLOCK") name = layerLinetypes[layer] || "CONTINUOUS";
  if (name === "CONTINUOUS") return null;
  return ltypeDashes[name] || null;
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
// Beyond ordinary drawable shapes, this also pulls out two kinds of control entity — neither is
// rendered as its own visible shape, both are consumed elsewhere:
//   - POINT/TEXT/MTEXT -> "markers": a colour-resolvable position used to tag an enclosed region found
//     by polygonizeFaces() with that colour (see the module-level comment on why DXF needs this at
//     all — it has no native "this enclosed area is coloured X" concept outside HATCH).
//   - a LINE on a layer named "BUS_START" (case-insensitive) -> the vehicle's starting pose: its first
//     point is the start position, its direction (first point -> second point) is the start heading.
//     At most one is used; if several exist, the first one found wins.
function extractEntities(pairs, layerTable, ltypeDashes) {
  const { colors: layerColors, trueColors: layerTrueColors, lineweights: layerLineweights, linetypes: layerLinetypes } = layerTable;
  const entitiesStart = findSectionStart(pairs, "ENTITIES");
  if (entitiesStart < 0) return { shapes: [], markers: [], busStartRaw: null };
  const records = splitRecords(pairs, entitiesStart + 1, ["ENDSEC"]);
  const shapes = [];
  const markers = [];
  let busStartRaw = null;
  const skipped = {};
  const warnSkip = (type) => { skipped[type] = (skipped[type] || 0) + 1; };

  for (const rec of records) {
    const layer = firstVal(rec.pairs, 8, "0");
    const color = resolveColor(rec.pairs, layer, layerColors, layerTrueColors);
    // widthMm/dashRaw are per-record (an entity has one lineweight/linetype, even a multi-segment
    // polyline), attached uniformly to whatever shape(s) this record produces below.
    const widthMm = resolveLineweight(rec.pairs, layer, layerLineweights);
    const dashRaw = resolveLinetypeDashes(rec.pairs, layer, layerLinetypes, ltypeDashes);

    if (rec.type === "LINE") {
      const p0 = { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) };
      const p1 = { x: parseFloat(firstVal(rec.pairs, 11, 0)), y: parseFloat(firstVal(rec.pairs, 21, 0)) };
      if (layer.toUpperCase() === "BUS_START") {
        if (!busStartRaw) busStartRaw = { p0, p1 };
      } else {
        shapes.push({ type: "line", p0, p1, color, widthMm, dashRaw });
      }
    } else if (rec.type === "POINT") {
      markers.push({ pos: { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) }, color });
    } else if (rec.type === "TEXT" || rec.type === "MTEXT") {
      const label = firstVal(rec.pairs, 1, "");
      markers.push({ pos: { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) }, color: colorFromLabelText(label) || color });
    } else if (rec.type === "CIRCLE") {
      shapes.push({ type: "circle", center: { x: parseFloat(firstVal(rec.pairs, 10, 0)), y: parseFloat(firstVal(rec.pairs, 20, 0)) }, r: parseFloat(firstVal(rec.pairs, 40, 0)), color, widthMm, dashRaw });
    } else if (rec.type === "ARC") {
      const cx = parseFloat(firstVal(rec.pairs, 10, 0)), cy = parseFloat(firstVal(rec.pairs, 20, 0));
      const r = parseFloat(firstVal(rec.pairs, 40, 0));
      const a0 = parseFloat(firstVal(rec.pairs, 50, 0)) * Math.PI / 180;
      const a1raw = parseFloat(firstVal(rec.pairs, 51, 0)) * Math.PI / 180;
      const sweep = ((a1raw - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      shapes.push({
        type: "arc", color, r, widthMm, dashRaw,
        center: { x: cx, y: cy },
        p0: { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
        mid: { x: cx + r * Math.cos(a0 + sweep / 2), y: cy + r * Math.sin(a0 + sweep / 2) },
        p1: { x: cx + r * Math.cos(a0 + sweep), y: cy + r * Math.sin(a0 + sweep) },
      });
    } else if (rec.type === "LWPOLYLINE") {
      const closed = (parseInt(firstVal(rec.pairs, 70, "0"), 10) & 1) === 1;
      const verts = readVertices(rec.pairs);
      if (verts.length >= 2) shapes.push({ type: "polyline", segments: polylineSegments(verts, closed), closed, filled: closed, color, widthMm, dashRaw });
      else warnSkip("LWPOLYLINE (too few vertices)");
    } else if (rec.type === "HATCH") {
      // Walks every boundary path (group 91 = how many), not just the first — each one is either a
      // polyline-type loop (72/73/93 + a 10/20(/42) vertex stream) or an edge-type loop (93 + per-edge
      // 72=type/1=line/2=arc, 3=ellipse/4=spline unsupported), terminated by 97. A HATCH with N>1
      // loops isn't N separate shapes — it's one fill with island loops cut out of it (e.g. a paved
      // area with an unpaved circle island inside), so all loops become one shape's `segments`
      // (outer) + `extraLoops` (the rest), rendered as one <path> with several M...Z subpaths under
      // fill-rule="evenodd" (see dxfShapePathD) — that's what correctly punches the holes, not
      // anything explicit about which loop is an "island". Any parse failure anywhere (an unsupported
      // edge type, a short/degenerate loop) skips the whole entity rather than rendering a partial,
      // wrong-looking fill.
      const nLoops = parseInt(firstVal(rec.pairs, 91, "0"), 10);
      const hp = rec.pairs;
      let i = hp.findIndex(([c]) => c === 92);
      const loops = [];
      let ok = i >= 0 && nLoops >= 1;
      for (let loopIdx = 0; ok && loopIdx < nLoops; loopIdx++) {
        if (i >= hp.length || hp[i][0] !== 92) { ok = false; break; }
        const isPolylineBoundary = (parseInt(hp[i][1], 10) & 2) === 2;
        i++; // past the 92 itself
        if (isPolylineBoundary) {
          const vertPairs = [];
          while (i < hp.length && hp[i][0] !== 97) { vertPairs.push(hp[i]); i++; }
          i++; // past 97
          const verts = readVertices(vertPairs);
          if (verts.length < 3) { ok = false; break; }
          loops.push(polylineSegments(verts, true));
        } else {
          const segs = [];
          while (ok && i < hp.length && hp[i][0] !== 97) {
            if (hp[i][0] !== 72) { i++; continue; }
            const edgeType = parseInt(hp[i][1], 10);
            if (edgeType === 1) {
              segs.push({ p0: { x: parseFloat(hp[i + 1][1]), y: parseFloat(hp[i + 2][1]) }, p1: { x: parseFloat(hp[i + 3][1]), y: parseFloat(hp[i + 4][1]) }, arc: null });
              i += 5;
            } else if (edgeType === 2) {
              const cx = parseFloat(hp[i + 1][1]), cy = parseFloat(hp[i + 2][1]), r = parseFloat(hp[i + 3][1]);
              const a0 = parseFloat(hp[i + 4][1]) * Math.PI / 180, a1 = parseFloat(hp[i + 5][1]) * Math.PI / 180;
              const ccw = hp[i + 6] && hp[i + 6][0] === 73 ? hp[i + 6][1] === "1" : true;
              const sweep = ccw ? (((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI) : -(((a0 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI);
              const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
              const p1 = { x: cx + r * Math.cos(a0 + sweep), y: cy + r * Math.sin(a0 + sweep) };
              segs.push({ p0, p1, arc: { center: { x: cx, y: cy }, r, mid: { x: cx + r * Math.cos(a0 + sweep / 2), y: cy + r * Math.sin(a0 + sweep / 2) } } });
              i += (hp[i + 6] && hp[i + 6][0] === 73) ? 7 : 6;
            } else { ok = false; }
          }
          if (!ok) break;
          if (i < hp.length && hp[i][0] === 97) i++;
          if (segs.length < 1) { ok = false; break; }
          loops.push(segs);
        }
        if (loopIdx + 1 < nLoops) {
          const nextI = hp.findIndex(([c], idx) => idx >= i && c === 92);
          if (nextI < 0) { ok = false; break; }
          i = nextI;
        }
      }
      if (!ok || loops.length !== nLoops) {
        warnSkip(nLoops > 1 ? "HATCH (unsupported multi-loop boundary)" : "HATCH (unsupported boundary)");
        continue;
      }
      const [mainSegs, ...extraLoops] = loops;
      shapes.push({ type: "polyline", segments: mainSegs, extraLoops: extraLoops.length ? extraLoops : undefined, closed: true, filled: true, color, widthMm, dashRaw });
    } else if (["POLYLINE", "VERTEX", "SPLINE", "INSERT", "3DFACE", "SOLID", "DIMENSION"].includes(rec.type)) {
      warnSkip(rec.type);
    }
  }

  const skippedTypes = Object.keys(skipped);
  if (skippedTypes.length) {
    console.warn("DXF import: skipped unsupported entities —", skippedTypes.map((t) => `${t} x${skipped[t]}`).join(", "));
  }
  return { shapes, markers, busStartRaw };
}

function shapeBoundsPoints(shape) {
  if (shape.type === "line") return [shape.p0, shape.p1];
  if (shape.type === "circle") return [{ x: shape.center.x - shape.r, y: shape.center.y - shape.r }, { x: shape.center.x + shape.r, y: shape.center.y + shape.r }];
  if (shape.type === "arc") return [{ x: shape.center.x - shape.r, y: shape.center.y - shape.r }, { x: shape.center.x + shape.r, y: shape.center.y + shape.r }];
  if (shape.type === "polyline") {
    const pts = shape.segments.flatMap((s) => [s.p0, s.p1]);
    if (shape.extraLoops) for (const loop of shape.extraLoops) pts.push(...loop.flatMap((s) => [s.p0, s.p1]));
    return pts;
  }
  return [];
}

// ---------- polygonization (shared-edge face detection) ----------
// Builds every enclosed face from a network of LINE/ARC edges that may share endpoints/edges (drawn
// once, not retraced per adjacent region) — the same core technique behind PostGIS's ST_Polygonize /
// Shapely's polygonize: treat the edges as a planar graph, and at each vertex always continue along
// whichever other edge is immediately clockwise from the direction just arrived from, tracing out each
// minimal enclosed loop. A face only becomes a filled, coloured shape when a marker (see
// extractEntities) falls inside it — an unmarked face contributes nothing (its edges already render
// individually as plain line/arc shapes), so files with no markers pay no cost here.
//
// Requires real shared VERTICES at junctions, not just one edge's endpoint happening to touch another
// edge's interior (a "T" — e.g. a lane divider ending partway along one long unsplit boundary line):
// this deliberately doesn't do general segment-intersection/edge-splitting, only vertex-snapped
// adjacency (SNAP_TOL_M below). Draw the boundary in segments that meet the divider with a real vertex
// (use your CAD tool's endpoint/vertex snap) — a T-junction against an un-split edge won't be found.
const SNAP_TOL_M = 0.001; // 1mm — absorbs DXF export float noise between what's meant to be one shared vertex

function snapKey(p) {
  return `${Math.round(p.x / SNAP_TOL_M)},${Math.round(p.y / SNAP_TOL_M)}`;
}

// Same normalized-sweep derivation as dxfShapePathD's arcFlags (see its own comment for why sampling
// 3 known points beats recomputing an angle in some other frame) — kept as a separate copy rather than
// shared, so changes here can't risk regressing the already browser-verified rendering path.
function arcSweepInfo(c, p0, mid, p1) {
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  const norm = (a) => (((a - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const am = norm(Math.atan2(mid.y - c.y, mid.x - c.x));
  const a1 = norm(Math.atan2(p1.y - c.y, p1.x - c.x));
  const sweep = a1 >= am ? a1 : -(2 * Math.PI - a1);
  return { a0, sweep };
}

function sampleEdge(edge, t) {
  if (!edge.arc) return { x: edge.p0.x + (edge.p1.x - edge.p0.x) * t, y: edge.p0.y + (edge.p1.y - edge.p0.y) * t };
  const { a0, sweep } = arcSweepInfo(edge.arc.center, edge.p0, edge.arc.mid, edge.p1);
  const a = a0 + sweep * t;
  return { x: edge.arc.center.x + edge.arc.r * Math.cos(a), y: edge.arc.center.y + edge.arc.r * Math.sin(a) };
}

function orientedEdge(e, dir) {
  return dir ? e : { p0: e.p1, p1: e.p0, arc: e.arc };
}

// Direction of travel along a directed half-edge (p0->p1 if dir, else p1->p0), sampled near its start
// (atStart: which way travel LEAVES this vertex) or its end (atStart=false: which way travel is
// HEADING as it arrives, extrapolated forward — the tangent to continue straight on).
function travelAngle(e, dir, atStart) {
  const oe = orientedEdge(e, dir);
  if (atStart) {
    const near = sampleEdge(oe, 0.02);
    return Math.atan2(near.y - oe.p0.y, near.x - oe.p0.x);
  }
  const near = sampleEdge(oe, 0.98);
  return Math.atan2(oe.p1.y - near.y, oe.p1.x - near.x);
}

function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function flattenOriented(e, dir, samples) {
  const oe = orientedEdge(e, dir);
  const pts = [];
  for (let i = 0; i < samples; i++) pts.push(sampleEdge(oe, i / samples));
  return pts;
}

// worldShapes/worldMarkers are already in world-space metres (post toWorld) — polygonization only
// needs to reason about relative geometry, and doing it here (rather than in raw DXF space) means one
// consistent piece of angle/sweep math instead of two.
export function polygonizeFaces(worldShapes, worldMarkers) {
  const edges = worldShapes
    .filter((s) => s.type === "line" || s.type === "arc")
    .map((s) => ({ p0: s.p0, p1: s.p1, arc: s.type === "arc" ? { center: s.center, r: s.r, mid: s.mid } : null }));
  if (edges.length < 3 || worldMarkers.length === 0) return [];

  const adjacency = new Map(); // snapKey -> [{edgeIdx, atP0}]
  const addAdj = (key, entry) => { if (!adjacency.has(key)) adjacency.set(key, []); adjacency.get(key).push(entry); };
  edges.forEach((e, idx) => { addAdj(snapKey(e.p0), { edgeIdx: idx, atP0: true }); addAdj(snapKey(e.p1), { edgeIdx: idx, atP0: false }); });

  const visited = new Set();
  const loops = [];
  for (let idx = 0; idx < edges.length; idx++) {
    for (const dir of [true, false]) {
      const startKey = `${idx}:${dir}`;
      if (visited.has(startKey)) continue;
      const loop = [];
      let curIdx = idx, curDir = dir;
      let guard = 0;
      while (guard++ < edges.length * 2 + 5) {
        const key = `${curIdx}:${curDir}`;
        if (visited.has(key) && !(curIdx === idx && curDir === dir && loop.length === 0)) break;
        if (visited.has(key)) break;
        visited.add(key);
        loop.push({ edgeIdx: curIdx, dir: curDir });
        const e = edges[curIdx];
        const arrivingAt = curDir ? e.p1 : e.p0;
        const ref = travelAngle(e, curDir, false) + Math.PI; // reversed arrival heading
        const here = adjacency.get(snapKey(arrivingAt)) || [];
        let best = null, bestTurn = Infinity;
        for (const cand of here) {
          const isReverseOfCurrent = cand.edgeIdx === curIdx && cand.atP0 !== curDir;
          if (isReverseOfCurrent && here.length > 1) continue; // don't reverse back unless it's a dead end
          const dep = travelAngle(edges[cand.edgeIdx], cand.atP0, true);
          const turn = ((ref - dep) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
          if (turn < bestTurn) { bestTurn = turn; best = { edgeIdx: cand.edgeIdx, dir: cand.atP0 }; }
        }
        if (!best) break;
        curIdx = best.edgeIdx; curDir = best.dir;
        if (curIdx === idx && curDir === dir) { loop.push({ edgeIdx: curIdx, dir: curDir, closing: true }); break; }
      }
      if (loop.length >= 3) loops.push(loop.filter((s) => !s.closing));
    }
  }

  const faces = [];
  for (const loop of loops) {
    const flat = loop.flatMap(({ edgeIdx, dir }) => flattenOriented(edges[edgeIdx], dir, edges[edgeIdx].arc ? 12 : 1));
    if (signedArea(flat) <= 1e-9) continue; // outer/unbounded face (or degenerate) — not a fillable interior region
    const marker = worldMarkers.find((m) => pointInPolygon(m.pos, flat));
    if (!marker) continue; // no colour to give it — leave its edges to render individually
    const segments = loop.map(({ edgeIdx, dir }) => {
      const oe = orientedEdge(edges[edgeIdx], dir);
      return { p0: oe.p0, p1: oe.p1, arc: oe.arc ? { center: oe.arc.center, r: oe.arc.r, mid: oe.arc.mid } : null };
    });
    // A synthesized face has no single source entity to take a lineweight/linetype from (it's built
    // from several edges' worth of network) — default width, solid outline. Already in world-space
    // (polygonizeFaces runs on worldShapes), so widthM/dashM directly, not the raw widthMm/dashRaw
    // fields extractEntities' shapes carry before parseDxfToWorldShapes' unit conversion.
    faces.push({ type: "polyline", closed: true, filled: true, color: marker.color, widthM: LWDEFAULT_HUNDREDTHS_MM / 100000, dashM: null, segments });
  }
  return faces;
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
// picker the SVG import path uses) -> { shapes, widthM, heightM, startPose } in WORLD-SPACE metres,
// ready for toScreen() each frame exactly like the rest of the app's geometry — no per-render unit
// math, unlike the SVG import path (which keeps re-deriving its placement transform live because it's
// placing untouched foreign markup, not shapes this app controls). startPose is null unless the file
// had a BUS_START layer line (see extractEntities) — the caller decides what to do with it.
export function parseDxfToWorldShapes(text, unitToM) {
  const pairs = tokenize(text);
  if (findSectionStart(pairs, "ENTITIES") < 0) throw new Error("No ENTITIES section found — not a DXF file this importer recognises");
  const layerTable = parseLayerTable(pairs);
  const ltypeDashes = parseLtypeDashes(pairs);
  const { shapes: rawShapes, markers: rawMarkers, busStartRaw } = extractEntities(pairs, layerTable, ltypeDashes);
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
  // Lineweight (group 370) is always physical hundredths-of-a-mm regardless of the drawing's own
  // coordinate unit convention (see resolveLineweight) — widthM doesn't go through unitToM. Dash
  // pattern lengths (group 49) are drawing-unit distances exactly like coordinates, so dashM does.
  const widthM = (mm100) => mm100 / 100000;
  const dashM = (raw) => (raw ? raw.map((v) => v * unitToM) : null);
  const worldShapes = rawShapes.map((shape) => {
    if (shape.type === "line") return { type: "line", p0: tf(shape.p0), p1: tf(shape.p1), color: shape.color, widthM: widthM(shape.widthMm), dashM: dashM(shape.dashRaw) };
    if (shape.type === "circle") return { type: "circle", center: tf(shape.center), r: shape.r * unitToM, color: shape.color, widthM: widthM(shape.widthMm), dashM: dashM(shape.dashRaw) };
    if (shape.type === "arc") return { type: "arc", center: tf(shape.center), r: shape.r * unitToM, p0: tf(shape.p0), mid: tf(shape.mid), p1: tf(shape.p1), color: shape.color, widthM: widthM(shape.widthMm), dashM: dashM(shape.dashRaw) };
    // polyline
    const tfSegs = (segs) => segs.map((s) => ({
      p0: tf(s.p0), p1: tf(s.p1),
      arc: s.arc ? { center: tf(s.arc.center), r: s.arc.r * unitToM, mid: tf(s.arc.mid) } : null,
    }));
    return {
      type: "polyline", closed: shape.closed, filled: shape.filled, color: shape.color,
      widthM: widthM(shape.widthMm), dashM: dashM(shape.dashRaw),
      segments: tfSegs(shape.segments),
      extraLoops: shape.extraLoops ? shape.extraLoops.map(tfSegs) : undefined,
    };
  });

  const worldMarkers = rawMarkers.map((m) => ({ pos: tf(m.pos), color: m.color }));
  worldShapes.push(...polygonizeFaces(worldShapes, worldMarkers));

  let startPose = null;
  if (busStartRaw) {
    const p0 = tf(busStartRaw.p0), p1 = tf(busStartRaw.p1);
    startPose = { x: p0.x, y: p0.y, theta: Math.atan2(p1.y - p0.y, p1.x - p0.x) };
  }

  return { shapes: worldShapes, widthM: (maxX - minX) * unitToM, heightM: (maxY - minY) * unitToM, startPose };
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

function segmentsToPathD(segments, toScreenFn, viewScale, close) {
  let d = "";
  segments.forEach((seg, i) => {
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
  return close ? d + "Z " : d;
}

// Builds an SVG path `d` for anything except a plain circle (which the caller should render as a
// <circle> directly — no arc-flag ambiguity there since it has no start/end point). A polyline shape
// with extraLoops (a multi-loop HATCH — see extractEntities) becomes several "M...Z" subpaths in one
// `d`; the caller must render it with fill-rule="evenodd" so the extra loops correctly punch holes in
// the main one (an island) rather than just overlapping it — evenodd needs no reasoning about which
// loop is an island or which way it winds, unlike nonzero, which is why it's the right rule here.
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
    let d = segmentsToPathD(shape.segments, toScreenFn, viewScale, shape.closed);
    if (shape.extraLoops) for (const loop of shape.extraLoops) d += segmentsToPathD(loop, toScreenFn, viewScale, true);
    return d.trim();
  }
  return null; // circle
}

// A literal real-world-mm -> screen-px conversion is worthless at this app's usual zoom: a site plan
// spans tens-to-hundreds of metres, so even a "heavy" 2mm DXF lineweight comes out under a pixel
// (2mm * ~20px/m ≈ 0.04px) — every weight would render identically at 0px and the whole feature would
// be invisible in normal use. So a lineweight maps to a MINIMUM on-screen width by weight category
// (thin/normal/heavy stay visually distinct at the zoom levels this app is actually used at) rather
// than a literal physical width — but it's a floor, not a fixed value: dxfShapeStrokeWidth still
// computes the true real-world-scaled width too, so a heavy line genuinely gets thicker than a thin
// one once you're zoomed in close enough for the real-world size to exceed this floor (e.g. inspecting
// a kerb line from a few metres away) — thin lines never disappear, heavy ones aren't fake-thick.
const LINEWEIGHT_BASELINE_PX = [[0, 0.6], [13, 0.8], [25, 1.0], [35, 1.2], [50, 1.5], [70, 1.8], [100, 2.2], [140, 2.6]];
function lineweightBaselinePx(mm100) {
  for (const [max, px] of LINEWEIGHT_BASELINE_PX) if (mm100 <= max) return px;
  return 3.2;
}

export function dxfShapeStrokeWidth(shape, viewScale) {
  return Math.max(lineweightBaselinePx(shape.widthM * 100000), shape.widthM * viewScale);
}

// SVG stroke-dasharray from a DXF dash pattern already converted to world metres (dashM — see
// parseDxfToWorldShapes) — scaled to the current view like everything else (dash length behaves like
// any other on-map distance, not like lineweight's own deliberately-not-purely-physical scaling
// above), then made screen-legible: SVG dasharray only takes positive alternating lengths, but DXF's
// own pattern is signed (positive = dash, negative = gap) and a 0 entry means "a dot," which as a
// literal 0-length dash would just vanish — so each length's sign is dropped (position in the array
// already alternates dash/gap, matching SVG's own alternation) and a 0 becomes a short dot the current
// stroke width's own size, the same way a plotter draws one.
export function dxfShapeStrokeDasharray(shape, viewScale) {
  if (!shape.dashM) return undefined;
  const strokeW = dxfShapeStrokeWidth(shape, viewScale);
  return shape.dashM.map((v) => Math.max(Math.abs(v) * viewScale, v === 0 ? strokeW * 0.5 : 0.4)).join(" ");
}
