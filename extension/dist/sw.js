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
    const yMin = clampUnit(tl.y + stepY * i);
    rects.push({
      xMin: grow(tl.x + stepX * i + gapH, -1),
      xMax: grow(tl.x + stepX * (i + 1) + gapH, 1),
      yMin,
      yMax: clampUnit(yMin + dh)
    });
  }
  for (let i = 0; i < right; i++) {
    const stepX = (br.x - tr.x) / right;
    const stepY = (br.y - tr.y - 2 * gapV) / right;
    const xMax = clampUnit(tr.x + stepX * (i + 1));
    rects.push({
      xMin: clampUnit(xMax - dv),
      xMax,
      yMin: grow(tr.y + stepY * i + gapV, -1),
      yMax: grow(tr.y + stepY * (i + 1) + gapV, 1)
    });
  }
  for (let i = bottom - 1; i >= 0; i--) {
    const stepX = (br.x - bl.x - 2 * gapH) / bottom;
    const stepY = (br.y - bl.y) / bottom;
    const yMax = clampUnit(bl.y + stepY * i);
    rects.push({
      xMin: grow(bl.x + stepX * i + gapH, -1),
      xMax: grow(bl.x + stepX * (i + 1) + gapH, 1),
      yMin: clampUnit(yMax - dh),
      yMax
    });
  }
  for (let i = left - 1; i >= 0; i--) {
    const stepX = (bl.x - tl.x) / left;
    const stepY = (bl.y - tl.y - 2 * gapV) / left;
    const xMin = clampUnit(tl.x + stepX * i);
    rects.push({
      xMin,
      xMax: clampUnit(xMin + dv),
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
  let at = mod(clockwise ? cornerIndex(spec, spec.start) : cornerIndex(spec, spec.start) - 1, total);
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
var DEPTH_MAX = 0.5;
var OVERLAP_MAX = 0.5;
var EDGE_GAP_MAX = 0.25;
function validateClassic(spec) {
  for (const edge of ["top", "right", "bottom", "left"]) requireCount(edge, spec[edge]);
  const total = ledCount(spec);
  if (total === 0) throw new RangeError("layout: at least one LED is required");
  for (const depth of ["depthTopBottom", "depthLeftRight"]) {
    const d = spec[depth];
    if (!(d > 0 && d <= DEPTH_MAX)) throw new RangeError(`layout: ${depth} must be in (0, ${DEPTH_MAX}], got ${d}`);
  }
  if (!CORNERS.includes(spec.start)) throw new RangeError(`layout: unknown start corner ${String(spec.start)}`);
  if (typeof spec.clockwise !== "boolean") throw new TypeError(`layout: clockwise must be a boolean, got ${String(spec.clockwise)}`);
  if (spec.offset !== void 0 && !Number.isInteger(spec.offset)) {
    throw new RangeError(`layout: offset must be an integer, got ${spec.offset}`);
  }
  if (spec.overlap !== void 0) requireFraction("overlap", spec.overlap, OVERLAP_MAX);
  if (spec.edgeGap !== void 0) requireFraction("edgeGap", spec.edgeGap, EDGE_GAP_MAX);
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

// lib/engine/adjust.ts
var CUBE_CORNERS = Object.freeze(
  ["black", "red", "green", "blue", "cyan", "magenta", "yellow", "white"]
);
var IDENTITY_CORNERS = Object.freeze({
  black: Object.freeze({ r: 0, g: 0, b: 0 }),
  red: Object.freeze({ r: 1, g: 0, b: 0 }),
  green: Object.freeze({ r: 0, g: 1, b: 0 }),
  blue: Object.freeze({ r: 0, g: 0, b: 1 }),
  cyan: Object.freeze({ r: 0, g: 1, b: 1 }),
  magenta: Object.freeze({ r: 1, g: 0, b: 1 }),
  yellow: Object.freeze({ r: 1, g: 1, b: 0 }),
  white: Object.freeze({ r: 1, g: 1, b: 1 })
});
var ADJUSTMENT_DEFAULTS = Object.freeze({
  saturationGain: 1,
  brightnessGain: 1,
  taper: 1,
  brightness: 100,
  brightnessCompensation: 0,
  temperature: 6600,
  backlightThreshold: 0,
  backlightColored: false
});
var TEMPERATURE_MIN = 1e3;
var TEMPERATURE_MAX = 4e4;
var LAB_SCRATCH = new Float64Array(3);
var WEIGHT_SCRATCH = new Float64Array(8);

// lib/engine/types.ts
var NO_BORDER = Object.freeze({ unknown: false, topBottom: 0, leftRight: 0 });

// lib/engine/border.ts
var BORDER_MODES = Object.freeze(["default", "classic", "osd", "letterbox"]);
var BORDER_DEFAULTS = Object.freeze({
  mode: "default",
  threshold: 0.05,
  blurRemovePx: 1,
  unknownSwitchMs: 6e4,
  borderSwitchMs: 5e3,
  maxInconsistentMs: 1e3,
  enabled: true
});
var UNKNOWN_BORDER = Object.freeze({ unknown: true, topBottom: 0, leftRight: 0 });

// lib/engine/sample.ts
var SAMPLE_MODES = Object.freeze([
  "mean",
  "meanSquared",
  "unicolorMean",
  "dominant",
  "unicolorDominant",
  "dominantAdvanced",
  "unicolorDominantAdvanced"
]);
var SAMPLER_DEFAULTS = Object.freeze({
  reducedPixelSetFactor: 0,
  accuracyLevel: 2
});
var MAX_ACCURACY_LEVEL = 4;
var KMEANS_CONVERGENCE = 1 / 255;
var CLUSTER_SEEDS = Object.freeze([
  Object.freeze({ r: 0, g: 0, b: 0 }),
  Object.freeze({ r: 0, g: 1, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 1 }),
  Object.freeze({ r: 1, g: 0, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 0 })
]);

// lib/engine/effects.ts
var EFFECT_KINDS = [
  "rainbow",
  "blobs",
  "breathe",
  "candle",
  "comet",
  "police",
  "plasma",
  "twinkle",
  "scan",
  "wipe",
  "chase",
  "fire"
];
function isEffectKind(value) {
  return typeof value === "string" && EFFECT_KINDS.includes(value);
}
var COLOURED_EFFECTS = Object.freeze(["breathe", "candle", "twinkle", "scan", "chase", "comet"]);
var SPEED_MIN = 0.05;
var SPEED_MAX = 8;
var DEFAULT_SPEED = 1;
var clamp012 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function clampSpeed(value) {
  if (!Number.isFinite(value)) return DEFAULT_SPEED;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}
function parseEffectSpec(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("effects: a spec must be an object");
  }
  const raw = value;
  if (!isEffectKind(raw.kind)) {
    throw new RangeError(`effects: kind must be one of ${EFFECT_KINDS.join(", ")}, got ${String(raw.kind)}`);
  }
  const spec = { kind: raw.kind };
  if (raw.speed !== void 0) {
    if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed)) {
      throw new TypeError("effects: speed must be a finite number");
    }
    spec.speed = clampSpeed(raw.speed);
  }
  if (raw.brightness !== void 0) {
    if (typeof raw.brightness !== "number" || !Number.isFinite(raw.brightness)) {
      throw new TypeError("effects: brightness must be a finite number");
    }
    spec.brightness = clamp012(raw.brightness);
  }
  if (raw.color !== void 0) {
    const color = raw.color;
    if (typeof color !== "object" || color === null) throw new TypeError("effects: color must be an object");
    spec.color = { r: channel(color.r), g: channel(color.g), b: channel(color.b) };
  }
  return spec;
}
function channel(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`effects: a colour channel is an integer 0..255, got ${String(value)}`);
  }
  return value;
}

// lib/engine/smooth.ts
var SMOOTHING_DEFAULTS = Object.freeze({
  outputHz: 120,
  settlingMs: 150,
  minStep: 1 / 65535,
  decay: 1,
  attackMs: 15,
  releaseMs: 90,
  absFloor: 4 / 65535,
  relFloor: 0.01,
  cutThreshold: 0.25
});
var SMOOTHING_PROFILES = Object.freeze({
  /** Deliberate cuts, long dwell: smooth hard and let the bypass catch the cuts. */
  cinema: Object.freeze({ attackMs: 40, releaseMs: 200, cutThreshold: 0.25 }),
  /** The default. Sharp on the way up, quiet on the way down. */
  balanced: Object.freeze({ attackMs: 15, releaseMs: 90, cutThreshold: 0.25 }),
  /** Continuous motion you are reacting to: nearly transparent, no bypass. */
  competitive: Object.freeze({ attackMs: 6, releaseMs: 30, cutThreshold: 1 })
});
var SMOOTHING_PROFILE_NAMES = Object.freeze(["cinema", "balanced", "competitive"]);

// lib/engine/address.ts
var TO_WS = Object.freeze({
  http: "ws",
  https: "wss",
  ws: "ws",
  wss: "wss"
});

// lib/engine/wled.ts
var WLED_DEFAULT_GAMMA = 2.8;
var WLED_GAMMA_MIN = 1;
var WLED_GAMMA_MAX = 4;
var WLED_MAX_FRAME_BYTES = 1400;
var FRAME_OVERHEAD_BYTES = 40;
var LED_BYTES = 9;
var WLED_LEDS_PER_FRAME = Math.floor((WLED_MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES) / LED_BYTES);

// lib/engine/config.ts
var WIRE_FORMATS = Object.freeze(["Afx", "Awa", "Ada"]);
var OUTPUT_TRANSPORTS = Object.freeze(["serial", "websocket", "wled"]);
var CAPTURE_SOURCES = Object.freeze(["screen", "device"]);
var LAYER_KINDS = Object.freeze(["color", "effect"]);
var DEFAULT_OUTPUT = Object.freeze({
  transport: "serial",
  format: "Afx"
});
var DEFAULT_CAPTURE = Object.freeze({
  source: "screen",
  gridWidth: 128,
  gridHeight: 72,
  fps: 60,
  crop: Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 })
});
var DEFAULT_SMOOTHING = Object.freeze({ ...SMOOTHING_PROFILES.balanced });
var DEFAULT_COLOR = Object.freeze({
  brightness: ADJUSTMENT_DEFAULTS.brightness,
  saturationGain: ADJUSTMENT_DEFAULTS.saturationGain,
  temperature: ADJUSTMENT_DEFAULTS.temperature,
  taper: ADJUSTMENT_DEFAULTS.taper,
  backlightThreshold: ADJUSTMENT_DEFAULTS.backlightThreshold,
  backlightColored: ADJUSTMENT_DEFAULTS.backlightColored
});
var SATURATION_MAX = 2;
var TAPER_MAX = 1.6;
var DEFAULT_BORDER = Object.freeze({
  enabled: BORDER_DEFAULTS.enabled,
  mode: BORDER_DEFAULTS.mode,
  threshold: BORDER_DEFAULTS.threshold,
  blurRemovePx: BORDER_DEFAULTS.blurRemovePx
});
var DEFAULT_SAMPLING = Object.freeze({
  mode: "mean",
  reducedPixelSetFactor: SAMPLER_DEFAULTS.reducedPixelSetFactor,
  accuracyLevel: SAMPLER_DEFAULTS.accuracyLevel
});
var MAX_PIXEL_SET_FACTOR = 3;
var BORDER_THRESHOLD_MAX = 0.2;
var BLUR_REMOVE_MAX = 8;
var DEFAULT_BACKGROUND = Object.freeze({
  enabled: false,
  kind: "color",
  color: Object.freeze({ r: 255, g: 170, b: 100 }),
  effect: "candle"
});
var DEFAULT_STARTUP = Object.freeze({
  ...DEFAULT_BACKGROUND,
  kind: "effect",
  effect: "rainbow",
  durationMs: 3e3
});
var STARTUP_MS_MIN = 100;
var STARTUP_MS_MAX = 3e4;
var SMOOTHING_MS_MIN = 1;
var SMOOTHING_MS_MAX = 2e3;
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
  capture: DEFAULT_CAPTURE,
  smoothing: DEFAULT_SMOOTHING,
  color: DEFAULT_COLOR,
  border: DEFAULT_BORDER,
  sampling: DEFAULT_SAMPLING,
  background: DEFAULT_BACKGROUND,
  startup: DEFAULT_STARTUP
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
function readLayer(value, path, fallback) {
  const raw = value === void 0 ? {} : object(value, `config.${path}`);
  const colorRaw = raw.color === void 0 ? void 0 : object(raw.color, `${path}.color`);
  const kind = raw.kind === void 0 ? fallback.kind : readLayerKind(raw.kind, `${path}.kind`);
  return {
    enabled: raw.enabled === void 0 ? fallback.enabled : boolean(raw.enabled, `${path}.enabled`),
    kind,
    color: colorRaw === void 0 ? { ...fallback.color } : {
      r: integer(colorRaw.r, `${path}.color.r`, 0, 255),
      g: integer(colorRaw.g, `${path}.color.g`, 0, 255),
      b: integer(colorRaw.b, `${path}.color.b`, 0, 255)
    },
    // The effects module owns what a valid effect is; asking it here keeps one
    // definition rather than two that drift.
    effect: raw.effect === void 0 ? fallback.effect : parseEffectSpec({ kind: raw.effect }).kind
  };
}
function readLayerKind(value, path) {
  if (value !== "color" && value !== "effect") {
    throw new ConfigError(path, `must be one of ${LAYER_KINDS.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function readSampleMode(value, path) {
  if (typeof value !== "string" || !SAMPLE_MODES.includes(value)) {
    throw new ConfigError(path, `must be one of ${SAMPLE_MODES.join(", ")}, got ${describe(value)}`);
  }
  return value;
}
function readBorderMode(value, path) {
  if (typeof value !== "string" || !BORDER_MODES.includes(value)) {
    throw new ConfigError(path, `must be one of ${BORDER_MODES.join(", ")}, got ${describe(value)}`);
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
function readCaptureSource(value, path) {
  if (typeof value !== "string" || !CAPTURE_SOURCES.includes(value)) {
    throw new ConfigError(path, `must be one of ${CAPTURE_SOURCES.join(", ")}, got ${describe(value)}`);
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
    if (outputRaw.wledGamma !== void 0) throw new ConfigError("output.wledGamma", "is only used by WLED");
  } else {
    const host = outputRaw.host;
    if (typeof host !== "string" || host.trim() === "") {
      throw new ConfigError("output.host", `must be a non-empty address for the ${transport} transport, got ${describe(host)}`);
    }
    output.host = host.trim();
    if (transport === "wled") {
      output.segment = outputRaw.segment === void 0 ? 0 : integer(outputRaw.segment, "output.segment", 0);
      output.wledGamma = boundedFraction(outputRaw.wledGamma, "output.wledGamma", WLED_GAMMA_MIN, WLED_GAMMA_MAX, WLED_DEFAULT_GAMMA);
    } else {
      if (outputRaw.segment !== void 0) throw new ConfigError("output.segment", "is only used by WLED");
      if (outputRaw.wledGamma !== void 0) throw new ConfigError("output.wledGamma", "is only used by WLED");
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
  if (outputRaw.dither !== void 0) {
    if (typeof outputRaw.dither !== "boolean") {
      throw new ConfigError("output.dither", `must be true or false, got ${describe(outputRaw.dither)}`);
    }
    if (outputRaw.dither) {
      if (transport === "wled") {
        throw new ConfigError("output.dither", "is not used by WLED, which has its own JSON protocol");
      }
      if (format === "Afx") {
        throw new ConfigError("output.dither", "is not used by Afx, which the firmware dithers itself");
      }
      output.dither = true;
    }
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
  const source = captureRaw.source === void 0 ? "screen" : readCaptureSource(captureRaw.source, "capture.source");
  if (source === "screen" && captureRaw.deviceId !== void 0) {
    throw new ConfigError("capture.deviceId", "is only used when the source is a video input");
  }
  const capture = {
    source,
    gridWidth: integer(captureRaw.gridWidth ?? DEFAULT_CAPTURE.gridWidth, "capture.gridWidth", GRID_MIN, GRID_MAX),
    gridHeight: integer(captureRaw.gridHeight ?? DEFAULT_CAPTURE.gridHeight, "capture.gridHeight", GRID_MIN, GRID_MAX),
    fps: integer(captureRaw.fps ?? DEFAULT_CAPTURE.fps, "capture.fps", FPS_MIN, FPS_MAX),
    crop
  };
  if (source === "device" && captureRaw.deviceId !== void 0) {
    if (typeof captureRaw.deviceId !== "string" || captureRaw.deviceId === "") {
      throw new ConfigError("capture.deviceId", `must be a non-empty string, got ${describe(captureRaw.deviceId)}`);
    }
    capture.deviceId = captureRaw.deviceId;
  }
  const smoothingRaw = raw.smoothing === void 0 ? {} : object(raw.smoothing, "config.smoothing");
  const smoothing = {
    attackMs: boundedFraction(smoothingRaw.attackMs, "smoothing.attackMs", SMOOTHING_MS_MIN, SMOOTHING_MS_MAX, DEFAULT_SMOOTHING.attackMs),
    releaseMs: boundedFraction(smoothingRaw.releaseMs, "smoothing.releaseMs", SMOOTHING_MS_MIN, SMOOTHING_MS_MAX, DEFAULT_SMOOTHING.releaseMs),
    cutThreshold: boundedFraction(smoothingRaw.cutThreshold, "smoothing.cutThreshold", 0, 1, DEFAULT_SMOOTHING.cutThreshold)
  };
  const colorRaw = raw.color === void 0 ? {} : object(raw.color, "config.color");
  const color = {
    brightness: boundedFraction(colorRaw.brightness, "color.brightness", 0, 100, DEFAULT_COLOR.brightness),
    saturationGain: boundedFraction(colorRaw.saturationGain, "color.saturationGain", 0, SATURATION_MAX, DEFAULT_COLOR.saturationGain),
    temperature: boundedFraction(colorRaw.temperature, "color.temperature", TEMPERATURE_MIN, TEMPERATURE_MAX, DEFAULT_COLOR.temperature),
    taper: boundedFraction(colorRaw.taper, "color.taper", 1, TAPER_MAX, DEFAULT_COLOR.taper),
    backlightThreshold: boundedFraction(colorRaw.backlightThreshold, "color.backlightThreshold", 0, 100, DEFAULT_COLOR.backlightThreshold),
    backlightColored: colorRaw.backlightColored === void 0 ? DEFAULT_COLOR.backlightColored : boolean(colorRaw.backlightColored, "color.backlightColored")
  };
  const borderRaw = raw.border === void 0 ? {} : object(raw.border, "config.border");
  const border = {
    enabled: borderRaw.enabled === void 0 ? DEFAULT_BORDER.enabled : boolean(borderRaw.enabled, "border.enabled"),
    mode: borderRaw.mode === void 0 ? DEFAULT_BORDER.mode : readBorderMode(borderRaw.mode, "border.mode"),
    threshold: boundedFraction(borderRaw.threshold, "border.threshold", 0, BORDER_THRESHOLD_MAX, DEFAULT_BORDER.threshold),
    blurRemovePx: integer(borderRaw.blurRemovePx ?? DEFAULT_BORDER.blurRemovePx, "border.blurRemovePx", 0, BLUR_REMOVE_MAX)
  };
  const samplingRaw = raw.sampling === void 0 ? {} : object(raw.sampling, "config.sampling");
  const sampling = {
    mode: samplingRaw.mode === void 0 ? DEFAULT_SAMPLING.mode : readSampleMode(samplingRaw.mode, "sampling.mode"),
    reducedPixelSetFactor: integer(
      samplingRaw.reducedPixelSetFactor ?? DEFAULT_SAMPLING.reducedPixelSetFactor,
      "sampling.reducedPixelSetFactor",
      0,
      MAX_PIXEL_SET_FACTOR
    ),
    accuracyLevel: integer(
      samplingRaw.accuracyLevel ?? DEFAULT_SAMPLING.accuracyLevel,
      "sampling.accuracyLevel",
      0,
      MAX_ACCURACY_LEVEL
    )
  };
  const background = readLayer(raw.background, "background", DEFAULT_BACKGROUND);
  const startupBase = readLayer(raw.startup, "startup", DEFAULT_STARTUP);
  const startupRaw = raw.startup === void 0 ? {} : object(raw.startup, "config.startup");
  const startup = {
    ...startupBase,
    durationMs: integer(
      startupRaw.durationMs ?? DEFAULT_STARTUP.durationMs,
      "startup.durationMs",
      STARTUP_MS_MIN,
      STARTUP_MS_MAX
    )
  };
  const config = {
    layout,
    blacklist,
    colorOrder,
    output,
    capture,
    smoothing,
    color,
    border,
    sampling,
    background,
    startup
  };
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
  return config;
}
var MATRIX_ENGINE_CONFIG = Object.freeze({
  layout: Object.freeze({ kind: "matrix", ...MATRIX_REFERENCE }),
  blacklist: Object.freeze([]),
  colorOrder: Object.freeze({ order: DEFAULT_COLOR_ORDER }),
  output: DEFAULT_OUTPUT,
  capture: DEFAULT_CAPTURE,
  smoothing: DEFAULT_SMOOTHING,
  color: DEFAULT_COLOR,
  border: DEFAULT_BORDER,
  sampling: DEFAULT_SAMPLING,
  background: DEFAULT_BACKGROUND,
  startup: DEFAULT_STARTUP
});

// lib/engine/text.ts
var TEXT = Object.freeze({
  // The engine.
  noStripEnabled: "no strip is enabled",
  noNetworkAddress: "no address for the network output",
  noControlChannel: (link) => `${link}: this link has no control channel`,
  audioSourceLost: "the audio source went away",
  mixedContent: (transport) => `${transport}: an HTTPS page may not open ws:// (mixed content) - from this page a board on the LAN is reached only over wss:// (a TLS bridge on your network that the board sits behind); run the panel on localhost, where ws:// is allowed, or use the extension host`,
  // Frame sources.
  noVideoInput: "no video input found",
  videoInputGone: "the chosen video input is no longer there; pick it again on the Capture page",
  cameraDenied: "camera permission was refused",
  screenNotPicked: "no screen was picked",
  noMediaDevices: "this browser has no media devices",
  noScreenCapture: "this browser cannot capture a screen",
  noVideoTrack: "the capture gave no video track",
  no2dContext: "no 2d canvas context",
  noSelfTest: "this host has no self-test",
  pairFromExtension: "pair the port from the extension icon",
  noWebSerial: "this browser has no Web Serial",
  // Audio.
  noDisplayAudio: "this browser does not share tab or system audio",
  noAudioTrack: "no audio track was given",
  microphoneDenied: "microphone permission was refused",
  audioNotPicked: "no audio source was picked",
  // Strips.
  stripNotFound: (id) => `strip not found: ${id}`,
  tooManyStrips: (max, got) => got === void 0 ? `instances: at most ${max} strips` : `instances: at most ${max} strips, got ${got}`,
  noSuchStrip: (id) => `instances: no strip called ${id}`,
  lastStrip: "instances: the last strip cannot be removed",
  instancesNotList: "instances: must be a list",
  instancesEmpty: "instances: at least one strip is needed",
  duplicateStripId: (id) => `instances: ${id} appears twice`,
  stripNotObject: (index) => `instances: strip ${index} must be an object`,
  // Calibration.
  calibrationTooFew: (total) => `calibration: the strip needs at least 4 LEDs, got ${total}`,
  calibrationFourCorners: (marked) => `calibration: four corners must be marked, ${marked} were`,
  calibrationCornerRange: (max, got) => `calibration: a corner index must be 0..${max}, got ${got}`,
  calibrationNotPartition: (runs, covered, total) => `calibration: the corners do not partition the strip (${runs} = ${covered}, ${total} expected) - mark the corners in the order the light reaches them`,
  // Storage and profiles.
  storageDenied: "the browser denies local storage",
  profilesUnreadable: (reason) => `the saved profiles could not be read: ${reason}`,
  profilesNotList: "the saved profiles are not a list",
  profilesDropped: (count) => `${count} profile(s) could not be read and were skipped`,
  notJson: (reason) => `not valid JSON: ${reason}`,
  notProfileFile: "this is not an AmbiFlux profile file",
  noReadableProfiles: "the file has no readable profile",
  // The extension, as the panel sees it.
  unexpectedReply: "the extension gave an unexpected reply",
  configRefused: "the extension did not accept the configuration",
  boardRefused: "the board did not accept the request",
  stripsRefused: "the extension did not accept the strip list"
});

// lib/engine/instances.ts
var MAX_INSTANCES = 8;
function defaultInstances() {
  return [{ id: "instance-1", name: "\u015Eerit 1", enabled: true, config: DEFAULT_ENGINE_CONFIG }];
}
function updateInstance(list, id, change) {
  let found = false;
  const next = list.map((instance) => {
    if (instance.id !== id) return instance;
    found = true;
    return { ...instance, ...change, id: instance.id };
  });
  if (!found) throw new RangeError(TEXT.noSuchStrip(id));
  return next;
}
function findInstance(list, id) {
  return list.find((instance) => instance.id === id) ?? null;
}
var InstanceError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InstanceError";
  }
};
function parseInstances(value) {
  if (!Array.isArray(value)) throw new InstanceError(TEXT.instancesNotList);
  if (value.length === 0) throw new InstanceError(TEXT.instancesEmpty);
  if (value.length > MAX_INSTANCES) {
    throw new InstanceError(TEXT.tooManyStrips(MAX_INSTANCES, value.length));
  }
  const seen = /* @__PURE__ */ new Set();
  return value.map((entry, index) => {
    const instance = parseInstance(entry, index);
    if (seen.has(instance.id)) throw new InstanceError(TEXT.duplicateStripId(instance.id));
    seen.add(instance.id);
    return instance;
  });
}
function parseInstance(value, index = 0) {
  if (typeof value !== "object" || value === null) {
    throw new InstanceError(TEXT.stripNotObject(index));
  }
  const raw = value;
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `instance-${index + 1}`;
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : `\u015Eerit ${index + 1}`;
  return {
    id,
    name,
    enabled: raw.enabled !== false,
    // Thrown as it comes: a ConfigError names the field that is wrong, which is
    // more use than an "instance 2 is invalid" that hides it.
    config: parseEngineConfig(raw.config)
  };
}

// lib/extension/messages.ts
function isMessage(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string" && value.type.startsWith("ambiflux/");
}

// lib/engine/schedule.ts
var MINUTES_IN_DAY = 1440;
var ACTION_KINDS = ["stop", "capture", "effect", "color"];
var DEFAULT_GAP_MS = 10 * 60 * 1e3;
function parseRules(value) {
  if (!Array.isArray(value)) throw new TypeError("schedule: rules must be an array");
  const rules = value.map((entry, index) => parseRule(entry, index));
  const taken = new Set(rules.map((rule) => rule.id));
  const seen = /* @__PURE__ */ new Set();
  return rules.map((rule, index) => {
    let id = rule.id;
    if (seen.has(id)) {
      let n = index;
      do {
        id = `rule-${n++}`;
      } while (taken.has(id) || seen.has(id));
      taken.add(id);
    }
    seen.add(id);
    return id === rule.id ? rule : { ...rule, id };
  });
}
function parseRule(value, index = 0) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`schedule: rule ${index} must be an object`);
  }
  const raw = value;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : `rule-${index}`;
  if (typeof raw.atMinute !== "number" || !Number.isInteger(raw.atMinute) || raw.atMinute < 0 || raw.atMinute >= MINUTES_IN_DAY) {
    throw new RangeError(`schedule: rule ${index} atMinute must be an integer 0..1439, got ${String(raw.atMinute)}`);
  }
  const days = raw.days === void 0 ? [] : parseDays(raw.days, index);
  const instanceId = typeof raw.instanceId === "string" && raw.instanceId.trim() !== "" ? raw.instanceId.trim() : void 0;
  return {
    id,
    enabled: raw.enabled !== false,
    atMinute: raw.atMinute,
    days,
    action: parseAction(raw.action, index),
    ...instanceId === void 0 ? {} : { instanceId }
  };
}
function parseDays(value, index) {
  if (!Array.isArray(value)) throw new TypeError(`schedule: rule ${index} days must be an array`);
  const days = value.map((day) => {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`schedule: rule ${index} day must be an integer 0..6, got ${String(day)}`);
    }
    return day;
  });
  return [...new Set(days)].sort((a, b) => a - b);
}
function parseAction(value, index) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`schedule: rule ${index} action must be an object`);
  }
  const raw = value;
  switch (raw.kind) {
    case "stop":
      return { kind: "stop" };
    case "capture":
      return { kind: "capture" };
    case "effect":
      return { kind: "effect", spec: parseEffectSpec(raw.spec) };
    case "color": {
      const color = raw.color;
      if (typeof color !== "object" || color === null) {
        throw new TypeError(`schedule: rule ${index} colour must be an object`);
      }
      return { kind: "color", color: { r: channel2(color.r, index), g: channel2(color.g, index), b: channel2(color.b, index) } };
    }
    default:
      throw new RangeError(`schedule: rule ${index} kind must be one of ${ACTION_KINDS.join(", ")}, got ${String(raw.kind)}`);
  }
}
function channel2(value, index) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`schedule: rule ${index} colour channel must be an integer 0..255, got ${String(value)}`);
  }
  return value;
}

// extension/src/sw.ts
var OFFSCREEN_URL = "offscreen.html";
var INSTANCES_KEY = "ambiflux/instances";
var CONFIG_KEY = "ambiflux/config";
var SCHEDULE_KEY = "ambiflux/schedule";
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
      justification: "Screen capture, audio visualisation and output to a LED strip, with no tab open."
    }).finally(() => {
      creating = null;
    });
  }
  await creating;
}
var lastState = null;
var lastStats = null;
var instances = null;
var instancesProblem;
async function loadInstances() {
  if (instances !== null) return instances;
  try {
    const stored = await chrome.storage.local.get([INSTANCES_KEY, CONFIG_KEY]);
    const raw = stored[INSTANCES_KEY];
    if (raw !== void 0) {
      instances = parseInstances(raw);
      return instances;
    }
    instances = defaultInstances();
    const single = stored[CONFIG_KEY];
    if (single !== void 0) {
      instances = updateInstance(instances, instances[0].id, { config: parseEngineConfig(single) });
    }
  } catch (error) {
    instancesProblem = error instanceof Error ? error.message : String(error);
    instances = defaultInstances();
  }
  return instances;
}
function firstId(list) {
  return (list.find((instance) => instance.enabled) ?? list[0]).id;
}
async function setInstances(value) {
  let parsed;
  try {
    parsed = parseInstances(value);
  } catch (error) {
    return { instances: await loadInstances(), error: describe2(error) };
  }
  await chrome.storage.local.set({ [INSTANCES_KEY]: parsed });
  instances = parsed;
  instancesProblem = void 0;
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: "ambiflux/instances", target: "offscreen", instances: parsed });
    } catch {
    }
  }
  return { instances: parsed };
}
async function loadConfig(id) {
  const list = await loadInstances();
  if (id === void 0) return findInstance(list, firstId(list)).config;
  const found = findInstance(list, id);
  if (found === void 0 || found === null) throw new Error(TEXT.stripNotFound(id));
  return found.config;
}
async function setConfig(value, id) {
  const list = await loadInstances();
  const target = id ?? firstId(list);
  let parsed;
  try {
    parsed = parseEngineConfig(value);
  } catch (error) {
    return { config: await loadConfig(target), error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const result = await setInstances(updateInstance(list, target, { config: parsed }));
    if (result.error !== void 0) return { config: await loadConfig(target), error: result.error };
  } catch (error) {
    return { config: await loadConfig(target), error: error instanceof Error ? error.message : String(error) };
  }
  return { config: parsed };
}
var schedule = null;
var scheduleProblem;
async function loadSchedule() {
  if (schedule !== null) return schedule;
  try {
    const stored = await chrome.storage.local.get(SCHEDULE_KEY);
    const raw = stored[SCHEDULE_KEY];
    schedule = raw === void 0 ? [] : parseRules(raw);
  } catch (error) {
    scheduleProblem = describe2(error);
    schedule = [];
  }
  return schedule;
}
function describe2(error) {
  return error instanceof Error ? error.message : String(error);
}
async function setSchedule(value) {
  let parsed;
  try {
    parsed = parseRules(value);
  } catch (error) {
    return { rules: await loadSchedule(), error: error instanceof Error ? error.message : String(error) };
  }
  await chrome.storage.local.set({ [SCHEDULE_KEY]: parsed });
  schedule = parsed;
  scheduleProblem = void 0;
  if (parsed.length > 0) await ensureOffscreen();
  if (await offscreenExists()) {
    try {
      await chrome.runtime.sendMessage({ type: "ambiflux/schedule", target: "offscreen", rules: parsed });
    } catch {
    }
  }
  return { rules: parsed };
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
  const pool = alive ? lastStats?.pool : void 0;
  return {
    type: "ambiflux/status-reply",
    version: APP_VERSION,
    state: alive ? lastState?.state ?? "idle" : "idle",
    stats: alive ? lastStats?.stats ?? null : null,
    ...pool === void 0 ? {} : { pool }
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
      status().then(sendResponse, (error) => sendResponse({ error: describe2(error) }));
      return true;
    case "ambiflux/config":
      setConfig(message.config, message.instance).then(
        (result) => sendResponse({
          type: "ambiflux/config-reply",
          config: result.config,
          ...result.error === void 0 ? {} : { error: result.error }
        }),
        (error) => sendResponse({ type: "ambiflux/config-reply", config: null, error: describe2(error) })
      );
      return true;
    case "ambiflux/config-get":
      loadConfig(message.instance).then(
        (current) => sendResponse({ type: "ambiflux/config-reply", config: current }),
        (error) => sendResponse({ type: "ambiflux/config-reply", config: null, error: describe2(error) })
      );
      return true;
    case "ambiflux/instances":
      setInstances(message.instances).then(
        (result) => sendResponse({
          type: "ambiflux/instances-reply",
          instances: result.instances,
          ...result.error === void 0 ? {} : { error: result.error }
        }),
        (error) => sendResponse({ type: "ambiflux/instances-reply", instances: null, error: describe2(error) })
      );
      return true;
    // Answered from storage like the schedule, and for the same reason: a panel
    // that opens the strips page must not be the reason the engine exists.
    case "ambiflux/instances-get":
      loadInstances().then(
        (list) => sendResponse({
          type: "ambiflux/instances-reply",
          instances: list,
          ...instancesProblem === void 0 ? {} : { error: instancesProblem }
        }),
        (error) => sendResponse({ type: "ambiflux/instances-reply", instances: null, error: describe2(error) })
      );
      return true;
    case "ambiflux/schedule":
      setSchedule(message.rules).then(
        (result) => sendResponse({
          type: "ambiflux/schedule-reply",
          rules: result.rules,
          ...result.error === void 0 ? {} : { error: result.error }
        }),
        (error) => sendResponse({ type: "ambiflux/schedule-reply", rules: [], error: describe2(error) })
      );
      return true;
    // Answered from storage, never by waking the engine document: a panel that
    // opens the schedule page must not be the reason the document exists.
    case "ambiflux/schedule-get":
      loadSchedule().then(
        (rules) => sendResponse({
          type: "ambiflux/schedule-reply",
          rules,
          ...scheduleProblem === void 0 ? {} : { error: scheduleProblem }
        }),
        (error) => sendResponse({ type: "ambiflux/schedule-reply", rules: [], error: describe2(error) })
      );
      return true;
    case "ambiflux/prepare":
      ensureOffscreen().then(
        () => sendResponse({ ready: true }),
        (error) => sendResponse({ ready: false, error: describe2(error) })
      );
      return true;
    case "ambiflux/start":
    case "ambiflux/selftest":
    case "ambiflux/pattern":
    case "ambiflux/effect":
    case "ambiflux/audio":
    case "ambiflux/color":
    case "ambiflux/clear-layer":
    case "ambiflux/serial":
    case "ambiflux/control":
      relayToOffscreen({ ...message, target: "offscreen" }).then(sendResponse, (error) => sendResponse({ error: describe2(error) }));
      return true;
    // async response
    case "ambiflux/stop":
      offscreenExists().then((alive) => alive ? chrome.runtime.sendMessage({ ...message, target: "offscreen" }) : { state: "idle" }).then(sendResponse, (error) => sendResponse({ error: describe2(error) }));
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
var INTERNAL_ONLY = /* @__PURE__ */ new Set(["ambiflux/stats", "ambiflux/state"]);
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (isMessage(message) && INTERNAL_ONLY.has(message.type)) {
    sendResponse(void 0);
    return false;
  }
  return handle(message, sendResponse);
});
function currentStats() {
  return lastStats;
}
export {
  currentStats
};
