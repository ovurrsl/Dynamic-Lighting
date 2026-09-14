// data/version.ts
var APP_VERSION = "0.1.0";

// lib/engine/layout.ts
var CORNERS = Object.freeze(["top-left", "top-right", "bottom-right", "bottom-left"]);
var NO_KEYSTONE = Object.freeze({
  topLeft: Object.freeze({ x: 0, y: 0 }),
  topRight: Object.freeze({ x: 1, y: 0 }),
  bottomRight: Object.freeze({ x: 1, y: 1 }),
  bottomLeft: Object.freeze({ x: 0, y: 1 })
});
var REFERENCE_LAYOUT = Object.freeze({
  top: 35,
  right: 19,
  bottom: 35,
  left: 19,
  depthTopBottom: 0.12,
  depthLeftRight: 0.08,
  start: "top-left",
  clockwise: true
});
var LAYOUT_DEFAULTS = Object.freeze({
  offset: 0,
  overlap: 0,
  edgeGap: 0,
  aspectRatio: 16 / 9
});
function ledCount(spec) {
  return spec.top + spec.right + spec.bottom + spec.left;
}
function cornerIndex(spec, corner2) {
  switch (corner2) {
    case "top-left":
      return 0;
    case "top-right":
      return spec.top;
    case "bottom-right":
      return spec.top + spec.right;
    case "bottom-left":
      return spec.top + spec.right + spec.bottom;
  }
}
function classicLayout(spec) {
  validateClassic(spec);
  const { top, right, bottom, left, depthTopBottom: dh, depthLeftRight: dv } = spec;
  const keystone = spec.keystone ?? NO_KEYSTONE;
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = keystone;
  const overlap = spec.overlap ?? LAYOUT_DEFAULTS.overlap;
  const gapV = spec.edgeGap ?? LAYOUT_DEFAULTS.edgeGap;
  const gapH = gapV / (spec.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio);
  const grow = (v, sign) => clampUnit(v + sign * overlap);
  const rects = [];
  for (let i = 0; i < top; i++) {
    const stepX = (tr.x - tl.x - 2 * gapH) / top;
    const stepY = (tr.y - tl.y) / top;
    const yMin = tl.y + stepY * i;
    rects.push({
      xMin: grow(tl.x + stepX * i + gapH, -1),
      xMax: grow(tl.x + stepX * (i + 1) + gapH, 1),
      yMin,
      yMax: yMin + dh
    });
  }
  for (let i = 0; i < right; i++) {
    const stepX = (br.x - tr.x) / right;
    const stepY = (br.y - tr.y - 2 * gapV) / right;
    const xMax = tr.x + stepX * (i + 1);
    rects.push({
      xMin: xMax - dv,
      xMax,
      yMin: grow(tr.y + stepY * i + gapV, -1),
      yMax: grow(tr.y + stepY * (i + 1) + gapV, 1)
    });
  }
  for (let i = bottom - 1; i >= 0; i--) {
    const stepX = (br.x - bl.x - 2 * gapH) / bottom;
    const stepY = (br.y - bl.y) / bottom;
    const yMax = bl.y + stepY * i;
    rects.push({
      xMin: grow(bl.x + stepX * i + gapH, -1),
      xMax: grow(bl.x + stepX * (i + 1) + gapH, 1),
      yMin: yMax - dh,
      yMax
    });
  }
  for (let i = left - 1; i >= 0; i--) {
    const stepX = (bl.x - tl.x) / left;
    const stepY = (bl.y - tl.y - 2 * gapV) / left;
    const xMin = tl.x + stepX * i;
    rects.push({
      xMin,
      xMax: xMin + dv,
      yMin: grow(tl.y + stepY * i + gapV, -1),
      yMax: grow(tl.y + stepY * (i + 1) + gapV, 1)
    });
  }
  return orient(rects, spec);
}
function orient(geometric, spec) {
  const total = geometric.length;
  const gap = spec.gap;
  const clockwise = spec.clockwise;
  const hasGap = gap !== void 0 && gap.length > 0;
  const survives = (at2) => !hasGap || at2 < gap.position || at2 >= gap.position + gap.length;
  let at = clockwise ? cornerIndex(spec, spec.start) : mod(cornerIndex(spec, spec.start) - 1, total);
  while (!survives(at)) at = mod(at + (clockwise ? 1 : -1), total);
  const anchor = geometric[at];
  const kept = hasGap ? geometric.slice(0, gap.position).concat(geometric.slice(gap.position + gap.length)) : geometric;
  const oriented = clockwise ? kept : [...kept].reverse();
  const start = mod(oriented.indexOf(anchor) + (spec.offset ?? LAYOUT_DEFAULTS.offset), oriented.length);
  return oriented.slice(start).concat(oriented.slice(0, start));
}
var MATRIX_REFERENCE = Object.freeze({
  columns: 16,
  rows: 9,
  cabling: "snake",
  start: "top-left",
  direction: "horizontal"
});
function matrixLayout(spec) {
  validateMatrix(spec);
  const { columns, rows } = spec;
  const gap = spec.gap ?? {};
  const gapTop = gap.top ?? 0;
  const gapRight = gap.right ?? 0;
  const gapBottom = gap.bottom ?? 0;
  const gapLeft = gap.left ?? 0;
  const cellW = (1 - gapLeft - gapRight) / columns;
  const cellH = (1 - gapTop - gapBottom) / rows;
  const rects = [];
  const cell = (x, y) => {
    rects.push({
      xMin: gapLeft + x * cellW,
      xMax: gapLeft + (x + 1) * cellW,
      yMin: gapTop + y * cellH,
      yMax: gapTop + (y + 1) * cellH
    });
  };
  const [startEdgeY, startEdgeX] = spec.start.split("-");
  let fromX = startEdgeX === "right" ? columns - 1 : 0;
  let fromY = startEdgeY === "bottom" ? rows - 1 : 0;
  let toX = fromX === 0 ? columns - 1 : 0;
  let toY = fromY === 0 ? rows - 1 : 0;
  let forward = fromX < toX;
  let downward = fromY < toY;
  const snake = spec.cabling === "snake";
  if (spec.direction === "vertical") {
    for (let x = fromX; forward ? x <= toX : x >= toX; x += forward ? 1 : -1) {
      for (let y = fromY; downward ? y <= toY : y >= toY; y += downward ? 1 : -1) cell(x, y);
      if (snake) {
        downward = !downward;
        [fromY, toY] = [toY, fromY];
      }
    }
  } else {
    for (let y = fromY; downward ? y <= toY : y >= toY; y += downward ? 1 : -1) {
      for (let x = fromX; forward ? x <= toX : x >= toX; x += forward ? 1 : -1) cell(x, y);
      if (snake) {
        forward = !forward;
        [fromX, toX] = [toX, fromX];
      }
    }
  }
  return rects;
}
var DARK_RECT = Object.freeze({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 });
function applyBlacklist(rects, ranges) {
  const out = [...rects];
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || range.start < 0 || range.start >= out.length) {
      throw new RangeError(`layout: blacklist start ${range.start} is outside a strip of ${out.length}`);
    }
    if (!Number.isInteger(range.length) || range.length < 1) {
      throw new RangeError(`layout: blacklist length must be a positive integer, got ${range.length}`);
    }
    if (range.start + range.length > out.length) {
      throw new RangeError(`layout: blacklist ${range.start}..${range.start + range.length - 1} is outside a strip of ${out.length}`);
    }
    for (let i = 0; i < range.length; i++) out[range.start + i] = DARK_RECT;
  }
  return out;
}
function clampUnit(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mod(v, n) {
  return (v % n + n) % n;
}
function requireCount(name, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`layout: ${name} must be a non-negative integer, got ${n}`);
}
function requireFraction(name, v, max = 1) {
  if (!(v >= 0 && v <= max)) throw new RangeError(`layout: ${name} must be in [0, ${max}], got ${v}`);
}
function validateClassic(spec) {
  for (const edge of ["top", "right", "bottom", "left"]) requireCount(edge, spec[edge]);
  const total = ledCount(spec);
  if (total === 0) throw new RangeError("layout: at least one LED is required");
  for (const depth of ["depthTopBottom", "depthLeftRight"]) {
    const d = spec[depth];
    if (!(d > 0 && d <= 0.5)) throw new RangeError(`layout: ${depth} must be in (0, 0.5], got ${d}`);
  }
  if (!CORNERS.includes(spec.start)) throw new RangeError(`layout: unknown start corner ${String(spec.start)}`);
  if (typeof spec.clockwise !== "boolean") throw new TypeError(`layout: clockwise must be a boolean, got ${String(spec.clockwise)}`);
  if (spec.offset !== void 0 && !Number.isInteger(spec.offset)) {
    throw new RangeError(`layout: offset must be an integer, got ${spec.offset}`);
  }
  if (spec.overlap !== void 0) requireFraction("overlap", spec.overlap, 0.5);
  if (spec.edgeGap !== void 0) requireFraction("edgeGap", spec.edgeGap, 0.25);
  if (spec.aspectRatio !== void 0 && !(spec.aspectRatio > 0 && Number.isFinite(spec.aspectRatio))) {
    throw new RangeError(`layout: aspectRatio must be a positive finite number, got ${spec.aspectRatio}`);
  }
  if (spec.keystone !== void 0) {
    for (const corner2 of ["topLeft", "topRight", "bottomRight", "bottomLeft"]) {
      const point = spec.keystone[corner2];
      if (point === void 0) throw new RangeError(`layout: keystone is missing ${corner2}`);
      requireFraction(`keystone.${corner2}.x`, point.x);
      requireFraction(`keystone.${corner2}.y`, point.y);
    }
  }
  const gap = spec.gap;
  if (gap !== void 0) {
    if (!Number.isInteger(gap.position) || gap.position < 0 || gap.position >= total) {
      throw new RangeError(`layout: gap position must be an integer in 0..${total - 1}, got ${gap.position}`);
    }
    requireCount("gap length", gap.length);
    if (gap.position + gap.length > total) {
      throw new RangeError(`layout: gap ${gap.position}..${gap.position + gap.length - 1} runs past the ${total} LED positions`);
    }
    if (gap.length >= total) throw new RangeError(`layout: a gap of ${gap.length} leaves nothing of ${total} LED positions`);
  }
  const gapV = spec.edgeGap ?? LAYOUT_DEFAULTS.edgeGap;
  const gapH = gapV / (spec.aspectRatio ?? LAYOUT_DEFAULTS.aspectRatio);
  if (2 * gapH >= 1 || 2 * gapV >= 1) {
    throw new RangeError(`layout: edgeGap ${gapV} leaves no edge to place LEDs along`);
  }
}
function validateMatrix(spec) {
  for (const axis of ["columns", "rows"]) {
    if (!Number.isInteger(spec[axis]) || spec[axis] < 1) {
      throw new RangeError(`layout: ${axis} must be a positive integer, got ${spec[axis]}`);
    }
  }
  if (spec.cabling !== "snake" && spec.cabling !== "parallel") {
    throw new RangeError(`layout: unknown cabling ${String(spec.cabling)}`);
  }
  if (spec.direction !== "horizontal" && spec.direction !== "vertical") {
    throw new RangeError(`layout: unknown direction ${String(spec.direction)}`);
  }
  if (!CORNERS.includes(spec.start)) throw new RangeError(`layout: unknown start corner ${String(spec.start)}`);
  const gap = spec.gap ?? {};
  for (const side of ["top", "right", "bottom", "left"]) {
    const v = gap[side];
    if (v !== void 0) requireFraction(`gap.${side}`, v);
  }
  if ((gap.left ?? 0) + (gap.right ?? 0) >= 1) throw new RangeError("layout: the left and right gaps leave no width");
  if ((gap.top ?? 0) + (gap.bottom ?? 0) >= 1) throw new RangeError("layout: the top and bottom gaps leave no height");
}

// lib/engine/order.ts
var COLOR_ORDERS = Object.freeze(["rgb", "rbg", "grb", "gbr", "brg", "bgr"]);
var DEFAULT_COLOR_ORDER = "rgb";
var PERMUTATIONS = Object.freeze({
  rgb: Object.freeze([0, 1, 2]),
  rbg: Object.freeze([0, 2, 1]),
  grb: Object.freeze([1, 0, 2]),
  gbr: Object.freeze([1, 2, 0]),
  brg: Object.freeze([2, 0, 1]),
  bgr: Object.freeze([2, 1, 0])
});

// lib/engine/config.ts
var WIRE_FORMATS = Object.freeze(["Afx", "Awa", "Ada"]);
var OUTPUT_TRANSPORTS = Object.freeze(["serial", "websocket", "wled"]);
var DEFAULT_OUTPUT = Object.freeze({
  transport: "serial",
  format: "Afx"
});
var DEFAULT_CAPTURE = Object.freeze({
  gridWidth: 128,
  gridHeight: 72,
  fps: 60,
  crop: Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 })
});
var GRID_MIN = 16;
var GRID_MAX = 480;
var FPS_MIN = 1;
var FPS_MAX = 240;
var CROP_MAX = 0.45;
var DEFAULT_ENGINE_CONFIG = Object.freeze({
  layout: Object.freeze({ kind: "classic", ...REFERENCE_LAYOUT }),
  blacklist: Object.freeze([]),
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER }),
  output: DEFAULT_OUTPUT,
  capture: DEFAULT_CAPTURE
});
var ConfigError = class extends Error {
  path;
  constructor(path, message) {
    super(`config: ${path} ${message}`);
    this.name = "ConfigError";
    this.path = path;
  }
};
function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(path, `must be an object, got ${describe(value)}`);
  }
  return value;
}
function integer(value, path, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(path, `must be an integer in ${min}..${max}, got ${describe(value)}`);
  }
  return value;
}
function fraction(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(path, `must be a finite number, got ${describe(value)}`);
  }
  return value;
}
function boundedFraction(value, path, min, max, fallback) {
  if (value === void 0) return fallback;
  const n = fraction(value, path);
  if (n < min || n > max) throw new ConfigError(path, `must be in ${min}..${max}, got ${describe(value)}`);
  return n;
}
function readTransport(value, path) {
  if (typeof value !== "string" || !OUTPUT_TRANSPORTS.includes(value)) {
    throw new ConfigError(path, `must be one of ${OUTPUT_TRANSPORTS.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function readWireFormat(value, path) {
  if (typeof value !== "string" || !WIRE_FORMATS.includes(value)) {
    throw new ConfigError(path, `must be one of ${WIRE_FORMATS.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function boolean(value, path) {
  if (typeof value !== "boolean") throw new ConfigError(path, `must be a boolean, got ${describe(value)}`);
  return value;
}
function corner(value, path) {
  if (typeof value !== "string" || !CORNERS.includes(value)) {
    throw new ConfigError(path, `must be one of ${CORNERS.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function optional(value, path, read) {
  return value === void 0 ? void 0 : read(value, path);
}
function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value === "object" ? "an object" : String(value);
}
function readKeystone(value, path) {
  const raw = object(value, path);
  const point = (name) => {
    const p = object(raw[name], `${path}.${name}`);
    return { x: fraction(p.x, `${path}.${name}.x`), y: fraction(p.y, `${path}.${name}.y`) };
  };
  return {
    topLeft: point("topLeft"),
    topRight: point("topRight"),
    bottomRight: point("bottomRight"),
    bottomLeft: point("bottomLeft")
  };
}
function readClassic(raw) {
  const spec = {
    top: integer(raw.top, "layout.top", 0),
    right: integer(raw.right, "layout.right", 0),
    bottom: integer(raw.bottom, "layout.bottom", 0),
    left: integer(raw.left, "layout.left", 0),
    depthTopBottom: fraction(raw.depthTopBottom, "layout.depthTopBottom"),
    depthLeftRight: fraction(raw.depthLeftRight, "layout.depthLeftRight"),
    start: corner(raw.start, "layout.start"),
    clockwise: boolean(raw.clockwise, "layout.clockwise")
  };
  const offset = optional(raw.offset, "layout.offset", (v, p) => integer(v, p, Number.MIN_SAFE_INTEGER));
  if (offset !== void 0) spec.offset = offset;
  const overlap = optional(raw.overlap, "layout.overlap", fraction);
  if (overlap !== void 0) spec.overlap = overlap;
  const edgeGap = optional(raw.edgeGap, "layout.edgeGap", fraction);
  if (edgeGap !== void 0) spec.edgeGap = edgeGap;
  const aspectRatio = optional(raw.aspectRatio, "layout.aspectRatio", fraction);
  if (aspectRatio !== void 0) spec.aspectRatio = aspectRatio;
  const keystone = optional(raw.keystone, "layout.keystone", readKeystone);
  if (keystone !== void 0) spec.keystone = keystone;
  if (raw.gap !== void 0) {
    const gap = object(raw.gap, "layout.gap");
    spec.gap = {
      position: integer(gap.position, "layout.gap.position", 0),
      length: integer(gap.length, "layout.gap.length", 0)
    };
  }
  return spec;
}
function readMatrix(raw) {
  const cabling = raw.cabling;
  if (cabling !== "snake" && cabling !== "parallel") {
    throw new ConfigError("layout.cabling", `must be snake or parallel, got ${describe(cabling)}`);
  }
  const direction = raw.direction;
  if (direction !== "horizontal" && direction !== "vertical") {
    throw new ConfigError("layout.direction", `must be horizontal or vertical, got ${describe(direction)}`);
  }
  const spec = {
    columns: integer(raw.columns, "layout.columns", 1),
    rows: integer(raw.rows, "layout.rows", 1),
    cabling,
    direction,
    start: corner(raw.start, "layout.start")
  };
  if (raw.gap !== void 0) {
    const gap = object(raw.gap, "layout.gap");
    const side = (name) => optional(gap[name], `layout.gap.${name}`, fraction);
    spec.gap = {};
    for (const name of ["top", "right", "bottom", "left"]) {
      const v = side(name);
      if (v !== void 0) spec.gap[name] = v;
    }
  }
  return spec;
}
function readColorOrderName(value, path) {
  if (typeof value !== "string" || !COLOR_ORDERS.includes(value)) {
    throw new ConfigError(path, `must be one of ${COLOR_ORDERS.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function parseEngineConfig(value) {
  const raw = object(value, "config");
  const layoutRaw = object(raw.layout, "config.layout");
  const kind = layoutRaw.kind;
  if (kind !== "classic" && kind !== "matrix") {
    throw new ConfigError("layout.kind", `must be classic or matrix, got ${describe(kind)}`);
  }
  const layout = kind === "matrix" ? { kind, ...readMatrix(layoutRaw) } : { kind, ...readClassic(layoutRaw) };
  const blacklistRaw = raw.blacklist ?? [];
  if (!Array.isArray(blacklistRaw)) throw new ConfigError("blacklist", `must be an array, got ${describe(blacklistRaw)}`);
  const blacklist = blacklistRaw.map((entry, i) => {
    const range = object(entry, `blacklist[${i}]`);
    return {
      start: integer(range.start, `blacklist[${i}].start`, 0),
      length: integer(range.length, `blacklist[${i}].length`, 1)
    };
  });
  const colorOrderRaw = raw.colorOrder === void 0 ? {} : object(raw.colorOrder, "config.colorOrder");
  const colorOrder = {
    order: colorOrderRaw.order === void 0 ? DEFAULT_COLOR_ORDER : readColorOrderName(colorOrderRaw.order, "colorOrder.order")
  };
  if (colorOrderRaw.overrides !== void 0) {
    const overridesRaw = object(colorOrderRaw.overrides, "colorOrder.overrides");
    const overrides = {};
    for (const [at, order] of Object.entries(overridesRaw)) {
      const led = Number(at);
      if (!Number.isInteger(led) || led < 0) {
        throw new ConfigError(`colorOrder.overrides.${at}`, "must be keyed by a non-negative LED index");
      }
      overrides[led] = readColorOrderName(order, `colorOrder.overrides.${at}`);
    }
    colorOrder.overrides = overrides;
  }
  const outputRaw = raw.output === void 0 ? {} : object(raw.output, "config.output");
  const format = outputRaw.format === void 0 ? DEFAULT_OUTPUT.format : readWireFormat(outputRaw.format, "output.format");
  const transport = outputRaw.transport === void 0 ? DEFAULT_OUTPUT.transport : readTransport(outputRaw.transport, "output.transport");
  const output = { transport, format };
  if (transport === "serial") {
    if (outputRaw.host !== void 0) throw new ConfigError("output.host", "is only used by the network transports");
    if (outputRaw.segment !== void 0) throw new ConfigError("output.segment", "is only used by WLED");
  } else {
    const host = outputRaw.host;
    if (typeof host !== "string" || host.trim() === "") {
      throw new ConfigError("output.host", `must be a non-empty address for the ${transport} transport, got ${describe(host)}`);
    }
    output.host = host.trim();
    if (transport === "wled") {
      output.segment = outputRaw.segment === void 0 ? 0 : integer(outputRaw.segment, "output.segment", 0);
    } else if (outputRaw.segment !== void 0) {
      throw new ConfigError("output.segment", "is only used by WLED");
    }
  }
  if (transport === "wled" && outputRaw.format !== void 0 && outputRaw.format !== "Afx") {
    throw new ConfigError("output.format", "is not used by WLED, which has its own JSON protocol");
  }
  if (outputRaw.calibration !== void 0) {
    if (format !== "Awa") {
      throw new ConfigError("output.calibration", `is only carried by the Awa format, not ${format}`);
    }
    const cal = object(outputRaw.calibration, "output.calibration");
    output.calibration = {
      // Named as the protocol names them rather than as the UI might: one
      // vocabulary for the four bytes, so nothing has to translate between two.
      limit: integer(cal.limit, "output.calibration.limit", 0, 255),
      red: integer(cal.red, "output.calibration.red", 0, 255),
      green: integer(cal.green, "output.calibration.green", 0, 255),
      blue: integer(cal.blue, "output.calibration.blue", 0, 255)
    };
  }
  const captureRaw = raw.capture === void 0 ? {} : object(raw.capture, "config.capture");
  const cropRaw = captureRaw.crop === void 0 ? {} : object(captureRaw.crop, "config.capture.crop");
  const crop = {
    left: boundedFraction(cropRaw.left, "capture.crop.left", 0, CROP_MAX, DEFAULT_CAPTURE.crop.left),
    right: boundedFraction(cropRaw.right, "capture.crop.right", 0, CROP_MAX, DEFAULT_CAPTURE.crop.right),
    top: boundedFraction(cropRaw.top, "capture.crop.top", 0, CROP_MAX, DEFAULT_CAPTURE.crop.top),
    bottom: boundedFraction(cropRaw.bottom, "capture.crop.bottom", 0, CROP_MAX, DEFAULT_CAPTURE.crop.bottom)
  };
  if (crop.left + crop.right > 0.9) {
    throw new ConfigError("capture.crop", `left and right crop leave ${(1 - crop.left - crop.right).toFixed(2)} of the width`);
  }
  if (crop.top + crop.bottom > 0.9) {
    throw new ConfigError("capture.crop", `top and bottom crop leave ${(1 - crop.top - crop.bottom).toFixed(2)} of the height`);
  }
  const capture = {
    gridWidth: integer(captureRaw.gridWidth ?? DEFAULT_CAPTURE.gridWidth, "capture.gridWidth", GRID_MIN, GRID_MAX),
    gridHeight: integer(captureRaw.gridHeight ?? DEFAULT_CAPTURE.gridHeight, "capture.gridHeight", GRID_MIN, GRID_MAX),
    fps: integer(captureRaw.fps ?? DEFAULT_CAPTURE.fps, "capture.fps", FPS_MIN, FPS_MAX),
    crop
  };
  const config2 = { layout, blacklist, colorOrder, output, capture };
  let rects;
  try {
    rects = layout.kind === "matrix" ? matrixLayout(layout) : classicLayout(layout);
  } catch (error) {
    throw new ConfigError("layout", error instanceof Error ? error.message : String(error));
  }
  try {
    applyBlacklist(rects, blacklist);
  } catch (error) {
    throw new ConfigError("blacklist", error instanceof Error ? error.message : String(error));
  }
  for (const at of Object.keys(colorOrder.overrides ?? {})) {
    if (Number(at) >= rects.length) {
      throw new ConfigError(`colorOrder.overrides.${at}`, `is past the ${rects.length} LEDs the layout describes`);
    }
  }
  return config2;
}
var MATRIX_ENGINE_CONFIG = Object.freeze({
  layout: Object.freeze({ kind: "matrix", ...MATRIX_REFERENCE }),
  blacklist: Object.freeze([]),
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER }),
  output: DEFAULT_OUTPUT,
  capture: DEFAULT_CAPTURE
});

// lib/extension/messages.ts
function isMessage(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string" && value.type.startsWith("ambiflux/");
}

// extension/src/sw.ts
var OFFSCREEN_URL = "offscreen.html";
var CONFIG_KEY = "ambiflux/config";
var creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length > 0) return;
  if (creating === null) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // DISPLAY_MEDIA is the documented reason for exactly this use, and unlike
      // AUDIO_PLAYBACK it carries no lifetime limit: the document lives until
      // we close it or Chrome exits.
      // USER_MEDIA alongside DISPLAY_MEDIA: the audio visualiser opens a
      // microphone, and an offscreen document may only do that if it says so
      // here. It is a REASON, not a permission - the manifest deliberately does
      // NOT ask for `audioCapture`, because a permanent microphone grant on an
      // ambilight extension is exactly the kind of thing that should make a
      // user suspicious. The prompt happens, or the visualiser reports why not.
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA, chrome.offscreen.Reason.USER_MEDIA],
      justification: "Ekran yakalama, ses g\xF6rselle\u015Ftirme ve LED \u015Feridine \xE7\u0131k\u0131\u015F, hi\xE7bir sekme a\xE7\u0131k olmadan."
    }).finally(() => {
      creating = null;
    });
  }
  await creating;
}
var lastState = null;
var lastStats = null;
var config = null;
async function loadConfig() {
  if (config !== null) return config;
  try {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const raw = stored[CONFIG_KEY];
    config = raw === void 0 ? DEFAULT_ENGINE_CONFIG : parseEngineConfig(raw);
  } catch {
    config = DEFAULT_ENGINE_CONFIG;
  }
  return config;
}
async function setConfig(value) {
  let parsed;
  try {
    parsed = parseEngineConfig(value);
  } catch (error) {
    return { config: await loadConfig(), error: error instanceof Error ? error.message : String(error) };
  }
  config = parsed;
  await chrome.storage.local.set({ [CONFIG_KEY]: parsed });
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: "ambiflux/config", target: "offscreen", config: parsed });
    } catch {
    }
  }
  return { config: parsed };
}
async function relayToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}
async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}
async function status() {
  const alive = await offscreenExists();
  return {
    type: "ambiflux/status-reply",
    version: APP_VERSION,
    state: alive ? lastState?.state ?? "idle" : "idle",
    stats: alive ? lastStats?.stats ?? null : null
  };
}
function handle(message, sendResponse) {
  if (!isMessage(message)) return false;
  if ("target" in message && message.target !== "sw") return false;
  switch (message.type) {
    case "ambiflux/ping":
      sendResponse({
        type: "ambiflux/pong",
        version: APP_VERSION,
        engine: lastState?.state ?? "idle"
      });
      return false;
    case "ambiflux/status":
      status().then(sendResponse, (error) => sendResponse({ error: String(error) }));
      return true;
    case "ambiflux/config":
      setConfig(message.config).then(
        (result) => sendResponse({
          type: "ambiflux/config-reply",
          config: result.config,
          ...result.error === void 0 ? {} : { error: result.error }
        }),
        (error) => sendResponse({ type: "ambiflux/config-reply", config: null, error: String(error) })
      );
      return true;
    case "ambiflux/config-get":
      loadConfig().then(
        (current) => sendResponse({ type: "ambiflux/config-reply", config: current }),
        (error) => sendResponse({ type: "ambiflux/config-reply", config: null, error: String(error) })
      );
      return true;
    case "ambiflux/prepare":
      ensureOffscreen().then(
        () => sendResponse({ ready: true }),
        (error) => sendResponse({ ready: false, error: String(error) })
      );
      return true;
    case "ambiflux/start":
    case "ambiflux/selftest":
    case "ambiflux/pattern":
    case "ambiflux/effect":
    case "ambiflux/audio":
    case "ambiflux/serial":
    case "ambiflux/control":
      relayToOffscreen({ ...message, target: "offscreen" }).then(sendResponse, (error) => sendResponse({ error: String(error) }));
      return true;
    // async response
    case "ambiflux/stop":
      offscreenExists().then((alive) => alive ? chrome.runtime.sendMessage({ ...message, target: "offscreen" }) : { state: "idle" }).then(sendResponse, (error) => sendResponse({ error: String(error) }));
      return true;
    // The offscreen document reports upward; the worker keeps the latest so a
    // popup or page that opens later can read it without waiting for the next
    // tick. It does not forward on its own - the page asks.
    case "ambiflux/stats":
      lastStats = message;
      sendResponse(void 0);
      return false;
    case "ambiflux/state":
      lastState = message;
      sendResponse(void 0);
      return false;
    default:
      return false;
  }
}
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen().catch(() => {
  });
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen().catch(() => {
  });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handle(message, sendResponse));
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => handle(message, sendResponse));
function currentStats() {
  return lastStats;
}
export {
  currentStats
};
//# sourceMappingURL=sw.js.map
