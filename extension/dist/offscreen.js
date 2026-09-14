// lib/light.ts
function srgbToLinear(channel3) {
  return channel3 <= 0.04045 ? channel3 / 12.92 : ((channel3 + 0.055) / 1.055) ** 2.4;
}
function buildSrgbToLinearLut() {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function encodeLinear16(colors, out) {
  const bytes = out ?? new Uint8Array(colors.length * 2);
  for (let i = 0; i < colors.length; i++) {
    const v = Math.round(clamp01(colors[i] ?? 0) * 65535);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 255;
  }
  return bytes;
}
function encodeLinear8(colors, out) {
  const bytes = out ?? new Uint8Array(colors.length);
  for (let i = 0; i < colors.length; i++) {
    bytes[i] = Math.round(clamp01(colors[i] ?? 0) * 255);
  }
  return bytes;
}

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
function linearToOklabInto(r, g, b, out) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}
function oklabToLinearInto(L, a, b, out) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}
function oklabGain(r, g, b, saturationGain, brightnessGain, out) {
  linearToOklabInto(r, g, b, out);
  const L = (out[0] ?? 0) * brightnessGain;
  const a = (out[1] ?? 0) * saturationGain * brightnessGain;
  const bb = (out[2] ?? 0) * saturationGain * brightnessGain;
  oklabToLinearInto(L, a, bb, out);
  out[0] = clamp01(out[0] ?? 0);
  out[1] = clamp01(out[1] ?? 0);
  out[2] = clamp01(out[2] ?? 0);
}
function brightnessScalars(brightness, compensation) {
  if (brightness <= 0) return { rgb: 0, cmy: 0, w: 0 };
  const bIn = brightness < 50 ? -0.09 * brightness + 7.5 : -0.04 * brightness + 5;
  const fCmy = compensation / 100 + 1;
  const fW = compensation * 2 / 100 + 1;
  return {
    rgb: Math.min(1, 1 / bIn),
    cmy: Math.min(1, 1 / (bIn * fCmy)),
    w: Math.min(1, 1 / (bIn * fW))
  };
}
function cornerWeights(r, g, b, out = new Float64Array(8)) {
  const nr = 1 - r;
  const ng = 1 - g;
  const nb = 1 - b;
  out[0] = nr * ng * nb;
  out[1] = r * ng * nb;
  out[2] = nr * g * nb;
  out[3] = nr * ng * b;
  out[4] = nr * g * b;
  out[5] = r * ng * b;
  out[6] = r * g * nb;
  out[7] = r * g * b;
  return out;
}
var TEMPERATURE_MIN = 1e3;
var TEMPERATURE_MAX = 4e4;
function kelvinToSrgb(kelvin) {
  if (!Number.isFinite(kelvin)) throw new RangeError(`adjust: temperature must be a finite Kelvin value, got ${kelvin}`);
  const t = Math.floor(Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, kelvin)) / 100);
  const red = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return { r: clamp01(red / 255), g: clamp01(green / 255), b: clamp01(blue / 255) };
}
function kelvinToLinearRgb(kelvin) {
  const m = kelvinToSrgb(kelvin);
  return { r: srgbToLinear(m.r), g: srgbToLinear(m.g), b: srgbToLinear(m.b) };
}
function backlightFloor(threshold) {
  const t = Math.min(100, Math.max(0, threshold)) / 100;
  const shaped = (Math.pow(2, 2 * t) - 1) / 3;
  return srgbToLinear(shaped);
}
function parseLedSelector(selector, count) {
  const text = selector.trim();
  if (text === "*") return Array.from({ length: count }, (_, i) => i);
  const picked = /* @__PURE__ */ new Set();
  for (const token of text.split(",")) {
    const item = token.trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (match === null) throw new SyntaxError(`adjust: bad LED selector "${item}" in "${selector}"`);
    const start = Number(match[1]);
    const end = match[2] === void 0 ? start : Number(match[2]);
    if (start > end) throw new RangeError(`adjust: descending LED range "${item}"`);
    if (end >= count) throw new RangeError(`adjust: LED ${end} is outside the strip of ${count}`);
    for (let i = start; i <= end; i++) picked.add(i);
  }
  return [...picked];
}
var LAB_SCRATCH = new Float64Array(3);
var WEIGHT_SCRATCH = new Float64Array(8);
var CompiledProfile = class {
  saturationGain;
  brightnessGain;
  gainIsIdentity;
  taper;
  taperIsIdentity;
  /** Eight corner colours in `CUBE_CORNERS` order, each premultiplied by its scalar. */
  corners = new Float64Array(24);
  cornersAreIdentity;
  tempR;
  tempG;
  tempB;
  tempIsIdentity;
  floor;
  backlightColored;
  constructor(profile) {
    const d = ADJUSTMENT_DEFAULTS;
    this.saturationGain = finite("saturationGain", profile.saturationGain ?? d.saturationGain, 0, MAX_GAIN);
    this.brightnessGain = finite("brightnessGain", profile.brightnessGain ?? d.brightnessGain, 0, MAX_GAIN);
    this.gainIsIdentity = this.saturationGain === 1 && this.brightnessGain === 1;
    this.taper = finite("taper", profile.taper ?? d.taper, 0);
    if (this.taper === 0) throw new RangeError("adjust: taper must be positive; 0 would send every colour to full scale");
    this.taperIsIdentity = this.taper === 1;
    const brightness = finite("brightness", profile.brightness ?? d.brightness, 0, 100);
    const compensation = finite("brightnessCompensation", profile.brightnessCompensation ?? d.brightnessCompensation, 0, 100);
    const scalars = brightnessScalars(brightness, compensation);
    const scalarFor = {
      black: 1,
      red: scalars.rgb,
      green: scalars.rgb,
      blue: scalars.rgb,
      cyan: scalars.cmy,
      magenta: scalars.cmy,
      yellow: scalars.cmy,
      white: scalars.w
    };
    let identity = true;
    CUBE_CORNERS.forEach((name, k) => {
      const colour = profile[name] ?? IDENTITY_CORNERS[name];
      const ident = IDENTITY_CORNERS[name];
      const scale = scalarFor[name];
      const r = finite(`${name}.r`, colour.r, 0);
      const g = finite(`${name}.g`, colour.g, 0);
      const b = finite(`${name}.b`, colour.b, 0);
      if (scale !== 1 || r !== ident.r || g !== ident.g || b !== ident.b) identity = false;
      this.corners[k * 3] = r * scale;
      this.corners[k * 3 + 1] = g * scale;
      this.corners[k * 3 + 2] = b * scale;
    });
    this.cornersAreIdentity = identity;
    const temperature = kelvinToLinearRgb(profile.temperature ?? d.temperature);
    this.tempR = temperature.r;
    this.tempG = temperature.g;
    this.tempB = temperature.b;
    this.tempIsIdentity = this.tempR === 1 && this.tempG === 1 && this.tempB === 1;
    const threshold = finite("backlightThreshold", profile.backlightThreshold ?? d.backlightThreshold, 0, 100);
    this.floor = backlightFloor(threshold);
    const colored = profile.backlightColored ?? d.backlightColored;
    if (typeof colored !== "boolean") throw new TypeError(`adjust: backlightColored must be a boolean, got ${String(colored)}`);
    this.backlightColored = colored;
  }
  /** Runs the eight stages on the triple at `colors[i..i+2]`, in place. */
  adjust(colors, i, backlightEnabled) {
    let r = clampChannel(colors[i] ?? 0);
    let g = clampChannel(colors[i + 1] ?? 0);
    let b = clampChannel(colors[i + 2] ?? 0);
    if (!this.gainIsIdentity) {
      oklabGain(r, g, b, this.saturationGain, this.brightnessGain, LAB_SCRATCH);
      r = LAB_SCRATCH[0] ?? 0;
      g = LAB_SCRATCH[1] ?? 0;
      b = LAB_SCRATCH[2] ?? 0;
    }
    if (!this.taperIsIdentity) {
      r = Math.pow(r, this.taper);
      g = Math.pow(g, this.taper);
      b = Math.pow(b, this.taper);
    }
    if (!this.cornersAreIdentity) {
      const w = cornerWeights(r, g, b, WEIGHT_SCRATCH);
      const c = this.corners;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let k = 0; k < 8; k++) {
        const wk = w[k] ?? 0;
        sr += wk * (c[k * 3] ?? 0);
        sg += wk * (c[k * 3 + 1] ?? 0);
        sb += wk * (c[k * 3 + 2] ?? 0);
      }
      r = clamp01(sr);
      g = clamp01(sg);
      b = clamp01(sb);
    }
    if (!this.tempIsIdentity) {
      r *= this.tempR;
      g *= this.tempG;
      b *= this.tempB;
    }
    if (backlightEnabled && this.floor > 0 && r + g + b < 3 * this.floor) {
      const f = this.floor;
      if (this.backlightColored) {
        r = Math.max(r, f);
        g = Math.max(g, f);
        b = Math.max(b, f);
      } else {
        r = f;
        g = f;
        b = f;
      }
    }
    colors[i] = r;
    colors[i + 1] = g;
    colors[i + 2] = b;
  }
};
function finite(name, value, min, max = Number.POSITIVE_INFINITY) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`adjust: ${name} must be a number in [${min}, ${max}], got ${value}`);
  }
  return value;
}
var MAX_GAIN = 16;
function clampChannel(v) {
  return !(v >= 0) ? 0 : v > 1 ? 1 : v;
}
function createAdjustment(profiles, count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`adjust: count must be a positive integer, got ${count}`);
  const table = new Array(count).fill(null);
  for (const profile of profiles) {
    if (typeof profile.leds !== "string") throw new TypeError(`adjust: leds must be a selector string, got ${String(profile.leds)}`);
    const compiled = new CompiledProfile(profile);
    for (const led of parseLedSelector(profile.leds, count)) table[led] = compiled;
  }
  const unassigned = [];
  table.forEach((entry, led) => {
    if (entry === null) unassigned.push(led);
  });
  let backlight = true;
  return {
    count,
    unassigned: Object.freeze(unassigned),
    apply(colors) {
      const n = Math.min(count, Math.floor(colors.length / 3));
      for (let led = 0; led < n; led++) {
        const profile = table[led];
        if (profile == null) continue;
        profile.adjust(colors, led * 3, backlight);
      }
      return colors;
    },
    setBacklightEnabled(enabled) {
      backlight = enabled;
    },
    backlightEnabled() {
      return backlight;
    }
  };
}

// lib/engine/types.ts
var NO_BORDER = Object.freeze({ unknown: false, topBottom: 0, leftRight: 0 });
function allocLedColors(count) {
  return new Float32Array(count * 3);
}

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
function bordersEqual(a, b) {
  if (a.unknown || b.unknown) return a.unknown && b.unknown;
  return a.topBottom === b.topBottom && a.leftRight === b.leftRight;
}
function linearBlackThreshold(threshold) {
  return Math.fround(srgbToLinear(threshold));
}
function detectBorder(grid, mode, linearThreshold) {
  validateGrid(grid);
  switch (mode) {
    case "default":
      return detectDefault(grid, linearThreshold);
    case "classic":
      return detectClassic(grid, linearThreshold);
    case "osd":
      return detectOsd(grid, linearThreshold);
    case "letterbox":
      return detectLetterbox(grid, linearThreshold);
    default:
      throw new RangeError(`border: unknown mode ${String(mode)}`);
  }
}
function createBorderDetector(options, clock2) {
  return new BorderProcessor(options, clock2);
}
function isBlack(grid, t, x, y) {
  const i = (y * grid.width + x) * 3;
  const d = grid.data;
  return d[i] < t && d[i + 1] < t && d[i + 2] < t;
}
function border(leftRight, topBottom) {
  if (leftRight < 0 || topBottom < 0) return UNKNOWN_BORDER;
  return { unknown: false, topBottom, leftRight };
}
function findLeftRight(grid, t) {
  const { width: w, height: h } = grid;
  const w3 = Math.floor(w / 3);
  const h3 = Math.floor(h / 3);
  const h66 = h3 * 2;
  const yCenter = Math.floor(h / 2);
  const lastX = w - 1;
  for (let x = 0; x < w3; x++) {
    if (!isBlack(grid, t, lastX - x, yCenter) || !isBlack(grid, t, x, h3) || !isBlack(grid, t, x, h66)) return x;
  }
  return -1;
}
function detectDefault(grid, t) {
  const { width: w, height: h } = grid;
  const w3 = Math.floor(w / 3);
  const w66 = w3 * 2;
  const h3 = Math.floor(h / 3);
  const xCenter = Math.floor(w / 2);
  const lastY = h - 1;
  const leftRight = findLeftRight(grid, t);
  let topBottom = -1;
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, xCenter, lastY - y) || !isBlack(grid, t, w3, y) || !isBlack(grid, t, w66, y)) {
      topBottom = y;
      break;
    }
  }
  return border(leftRight, topBottom);
}
function detectClassic(grid, t) {
  const w3 = Math.floor(grid.width / 3);
  const h3 = Math.floor(grid.height / 3);
  const maxSize = Math.max(w3, h3);
  let x = -1;
  let y = -1;
  for (let i = 0; i < maxSize; i++) {
    const px = Math.min(i, w3);
    const py = Math.min(i, h3);
    if (!isBlack(grid, t, px, py)) {
      x = px;
      y = py;
      break;
    }
  }
  for (; x > 0; x--) if (isBlack(grid, t, x - 1, y)) break;
  for (; y > 0; y--) if (isBlack(grid, t, x, y - 1)) break;
  return border(x, y);
}
function detectOsd(grid, t) {
  const leftRight = findLeftRight(grid, t);
  if (leftRight < 0) return UNKNOWN_BORDER;
  const { width: w, height: h } = grid;
  const h3 = Math.floor(h / 3);
  const lastX = w - 1;
  const lastY = h - 1;
  const x = leftRight;
  const mirrorX = lastX - leftRight;
  let topBottom = -1;
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, x, y) || !isBlack(grid, t, x, lastY - y) || !isBlack(grid, t, mirrorX, y) || !isBlack(grid, t, mirrorX, lastY - y)) {
      topBottom = y;
      break;
    }
  }
  return border(leftRight, topBottom);
}
function detectLetterbox(grid, t) {
  const { width: w, height: h } = grid;
  const w25 = Math.floor(w / 4);
  const w75 = w25 * 3;
  const h3 = Math.floor(h / 3);
  const xCenter = Math.floor(w / 2);
  const lastY = h - 1;
  let topBottom = -1;
  for (let y = 0; y < h3; y++) {
    if (!isBlack(grid, t, xCenter, y) || !isBlack(grid, t, w25, y) || !isBlack(grid, t, w75, y) || !isBlack(grid, t, w25, lastY - y) || !isBlack(grid, t, w75, lastY - y)) {
      topBottom = y;
      break;
    }
  }
  return border(0, topBottom);
}
function validateGrid(grid) {
  const { width, height, data } = grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`border: grid must be at least 1x1, got ${width}x${height}`);
  }
  if (data.length < width * height * 3) {
    throw new RangeError(`border: grid data holds ${data.length} floats, ${width}x${height} needs ${width * height * 3}`);
  }
}
function withBlurRemoved(detected, px, grid) {
  if (detected.unknown || px === 0) return detected;
  const maxTopBottom = Math.floor((grid.height - 1) / 2);
  const maxLeftRight = Math.floor((grid.width - 1) / 2);
  return {
    unknown: false,
    topBottom: detected.topBottom > 0 ? Math.min(detected.topBottom + px, maxTopBottom) : 0,
    leftRight: detected.leftRight > 0 ? Math.min(detected.leftRight + px, maxLeftRight) : 0
  };
}
var BorderProcessor = class {
  mode;
  linearThreshold;
  clock;
  blurRemovePx;
  unknownSwitchMs;
  borderSwitchMs;
  maxInconsistentMs;
  userEnabled;
  hardDisabled = false;
  /** The border in effect (.cpp:21). Frozen, so a consumer can keep it. */
  currentBorder = UNKNOWN_BORDER;
  /** The border whose consistency is being measured (.cpp:22); null before the first detection. */
  candidate = null;
  /** When the candidate's run began. Meaningless while `candidate` is null. */
  consistentSince = 0;
  /** When the current run of detections disagreeing with the candidate began; null while they agree. */
  inconsistentSince = null;
  /** Time of the last frame that was processed; null before the first. */
  lastSeen = null;
  /** Set when detection stops; the first frame after it resumes shifts the runs past the gap. */
  resumePending = false;
  constructor(options, clock2) {
    this.clock = clock2;
    this.mode = options.mode ?? BORDER_DEFAULTS.mode;
    if (!BORDER_MODES.includes(this.mode)) throw new RangeError(`border: unknown mode ${String(this.mode)}`);
    const threshold = options.threshold ?? BORDER_DEFAULTS.threshold;
    if (!(threshold >= 0 && threshold <= 1)) throw new RangeError(`border: threshold must be in [0, 1], got ${threshold}`);
    this.linearThreshold = linearBlackThreshold(threshold);
    this.blurRemovePx = options.blurRemovePx ?? BORDER_DEFAULTS.blurRemovePx;
    if (!Number.isInteger(this.blurRemovePx) || this.blurRemovePx < 0) {
      throw new RangeError(`border: blurRemovePx must be a non-negative integer, got ${this.blurRemovePx}`);
    }
    this.unknownSwitchMs = requireDuration("unknownSwitchMs", options.unknownSwitchMs ?? BORDER_DEFAULTS.unknownSwitchMs);
    this.borderSwitchMs = requireDuration("borderSwitchMs", options.borderSwitchMs ?? BORDER_DEFAULTS.borderSwitchMs);
    this.maxInconsistentMs = requireDuration("maxInconsistentMs", options.maxInconsistentMs ?? BORDER_DEFAULTS.maxInconsistentMs);
    this.userEnabled = options.enabled ?? BORDER_DEFAULTS.enabled;
  }
  detect(grid) {
    return detectBorder(grid, this.mode, this.linearThreshold);
  }
  process(grid, now = this.clock()) {
    if (!this.active()) return NO_BORDER;
    if (!Number.isFinite(now)) throw new RangeError(`border: frame time must be finite, got ${now}`);
    if (this.resumePending) {
      this.resumePending = false;
      if (this.lastSeen !== null) {
        const gap = now - this.lastSeen;
        if (gap > 0) {
          this.consistentSince += gap;
          if (this.inconsistentSince !== null) this.inconsistentSince += gap;
        }
      }
    }
    this.update(withBlurRemoved(this.detect(grid), this.blurRemovePx, grid), now);
    this.lastSeen = now;
    return this.currentBorder;
  }
  current() {
    return this.active() ? this.currentBorder : NO_BORDER;
  }
  setEnabled(enabled) {
    const wasActive = this.active();
    this.userEnabled = enabled;
    if (wasActive && !this.active()) this.resumePending = true;
  }
  setDisabled(disabled) {
    const wasActive = this.active();
    this.hardDisabled = disabled;
    if (wasActive && !this.active()) this.resumePending = true;
  }
  // Hyperion keeps a third, derived flag up to date in both setters
  // (.cpp:100-109, :121-130); it always equals this conjunction.
  active() {
    return this.userEnabled && !this.hardDisabled;
  }
  reset() {
    this.currentBorder = UNKNOWN_BORDER;
    this.candidate = null;
    this.consistentSince = 0;
    this.inconsistentSince = null;
    this.lastSeen = null;
    this.resumePending = false;
  }
  update(detected, now) {
    if (this.candidate !== null && bordersEqual(detected, this.candidate)) {
      this.inconsistentSince = null;
    } else {
      if (this.candidate !== null) {
        this.inconsistentSince ??= now;
        if (now - this.inconsistentSince <= this.maxInconsistentMs) return;
      }
      this.candidate = detected;
      this.consistentSince = now;
      this.inconsistentSince = null;
    }
    if (bordersEqual(this.currentBorder, detected)) {
      this.inconsistentSince = null;
      return;
    }
    const consistentFor = now - this.consistentSince;
    const due = detected.unknown ? consistentFor >= this.unknownSwitchMs : this.currentBorder.unknown || consistentFor >= this.borderSwitchMs;
    if (due) this.currentBorder = Object.freeze({ ...detected });
  }
};
function requireDuration(name, value) {
  if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(`border: ${name} must be a finite non-negative number of ms, got ${value}`);
  return value;
}

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
function createColorOrder(count, options = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`order: count must be a positive integer, got ${count}`);
  const base = options.order ?? DEFAULT_COLOR_ORDER;
  requireOrder(base);
  const orders = new Array(count).fill(base);
  for (const [at, order] of Object.entries(options.overrides ?? {})) {
    const led = Number(at);
    if (!Number.isInteger(led) || led < 0 || led >= count) {
      throw new RangeError(`order: override index must be an integer 0..${count - 1}, got ${at}`);
    }
    requireOrder(order);
    orders[led] = order;
  }
  const table = new Uint8Array(count * 3);
  let identity = true;
  for (let led = 0; led < count; led++) {
    const permutation = PERMUTATIONS[orders[led]];
    for (let k = 0; k < 3; k++) table[led * 3 + k] = permutation[k];
    if (orders[led] !== "rgb") identity = false;
  }
  const frozen = Object.freeze([...orders]);
  return {
    count,
    identity,
    orders: () => frozen,
    apply(colors) {
      if (identity) return colors;
      if (colors.length < count * 3) {
        throw new RangeError(`order: frame holds ${colors.length} channels, ${count} LEDs need ${count * 3}`);
      }
      for (let led = 0; led < count; led++) {
        const at = led * 3;
        const r = colors[at];
        const g = colors[at + 1];
        const b = colors[at + 2];
        const p0 = table[at];
        const p1 = table[at + 1];
        const p2 = table[at + 2];
        colors[at] = p0 === 0 ? r : p0 === 1 ? g : b;
        colors[at + 1] = p1 === 0 ? r : p1 === 1 ? g : b;
        colors[at + 2] = p2 === 0 ? r : p2 === 1 ? g : b;
      }
      return colors;
    }
  };
}
function requireOrder(order) {
  if (!COLOR_ORDERS.includes(order)) throw new RangeError(`order: unknown colour order ${String(order)}`);
}

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
function resolveLayout(config) {
  const layout = config.layout;
  const rects = layout.kind === "matrix" ? matrixLayout(layout) : classicLayout(layout);
  return applyBlacklist(rects, config.blacklist);
}
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
  const config = { layout, blacklist, colorOrder, output, capture };
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
  capture: DEFAULT_CAPTURE
});

// lib/engine/protocol.ts
var HEADER_SIZE = 6;
var TRAILER_SIZE = 3;
var CALIBRATION_SIZE = 4;
var MAX_LEDS = 65536;
var BYTES_PER_LED = Object.freeze({ Ada: 3, Awa: 3, Afx: 6 });
var MAGIC_A = 65;
var MAGIC_ADA_1 = 100;
var MAGIC_ADA_2 = 97;
var MAGIC_AWA_1 = 119;
var MAGIC_AWA_2 = 97;
var MAGIC_AWA_2_CALIBRATED = 65;
var MAGIC_AFX_1 = 102;
var MAGIC_AFX_2 = 120;
var MAGIC_AXC_1 = 120;
var MAGIC_AXC_2 = 67;
var HEADER_XOR = 85;
var FLETCHER_ESCAPE = 65;
var FLETCHER_ESCAPED = 170;
function fletcherInto(bytes, start, end, out, at) {
  let fletcher1 = 0;
  let fletcher2 = 0;
  let fletcherExt = 0;
  let position = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    fletcherExt = (fletcherExt + (b ^ position)) % 255;
    position = position + 1 & 255;
    fletcher1 = (fletcher1 + b) % 255;
    fletcher2 = (fletcher2 + fletcher1) % 255;
  }
  out[at] = fletcher1;
  out[at + 1] = fletcher2;
  out[at + 2] = fletcherExt !== FLETCHER_ESCAPE ? fletcherExt : FLETCHER_ESCAPED;
}
function frameSize(kind, count, calibrated = false) {
  const body = HEADER_SIZE + count * BYTES_PER_LED[kind];
  switch (kind) {
    case "Ada":
      return body;
    case "Awa":
      return body + (calibrated ? CALIBRATION_SIZE : 0) + TRAILER_SIZE;
    case "Afx":
      return body + TRAILER_SIZE;
  }
}
function encodeAda(rgb8, out) {
  const count = validatePayload("Ada", rgb8);
  const frame = prepareOut("Ada", out, frameSize("Ada", count));
  placePayload(frame, rgb8);
  writeHeader(frame, MAGIC_ADA_1, MAGIC_ADA_2, count);
  return frame;
}
function encodeAwa(rgb8, calibration, out) {
  const count = validatePayload("Awa", rgb8);
  const calibrated = calibration !== void 0;
  if (calibrated) validateCalibration(calibration);
  const frame = prepareOut("Awa", out, frameSize("Awa", count, calibrated));
  placePayload(frame, rgb8);
  writeHeader(frame, MAGIC_AWA_1, calibrated ? MAGIC_AWA_2_CALIBRATED : MAGIC_AWA_2, count);
  let end = HEADER_SIZE + rgb8.length;
  if (calibrated) {
    frame[end] = calibration.limit;
    frame[end + 1] = calibration.red;
    frame[end + 2] = calibration.green;
    frame[end + 3] = calibration.blue;
    end += CALIBRATION_SIZE;
  }
  fletcherInto(frame, HEADER_SIZE, end, frame, end);
  return frame;
}
function encodeAfx(linear16be, out) {
  const count = validatePayload("Afx", linear16be);
  const frame = prepareOut("Afx", out, frameSize("Afx", count));
  placePayload(frame, linear16be);
  writeHeader(frame, MAGIC_AFX_1, MAGIC_AFX_2, count);
  const end = HEADER_SIZE + linear16be.length;
  fletcherInto(frame, HEADER_SIZE, end, frame, end);
  return frame;
}
function encodeAxc(tlv, out) {
  if (tlv.length < 1 || tlv.length > MAX_LEDS) {
    throw new RangeError(`protocol: an AxC body is 1..${MAX_LEDS} bytes, got ${tlv.length}`);
  }
  const total = HEADER_SIZE + tlv.length + TRAILER_SIZE;
  const frame = out === void 0 ? new Uint8Array(total) : out.length < total ? (() => {
    throw new RangeError(`protocol: out holds ${out.length} bytes, needs ${total}`);
  })() : out.subarray(0, total);
  placePayload(frame, tlv);
  writeHeader(frame, MAGIC_AXC_1, MAGIC_AXC_2, tlv.length);
  const end = HEADER_SIZE + tlv.length;
  fletcherInto(frame, HEADER_SIZE, end, frame, end);
  return frame;
}
function writeHeader(frame, magic1, magic2, count) {
  const encoded = count - 1;
  const hi = encoded >> 8;
  const lo = encoded & 255;
  frame[0] = MAGIC_A;
  frame[1] = magic1;
  frame[2] = magic2;
  frame[3] = hi;
  frame[4] = lo;
  frame[5] = hi ^ lo ^ HEADER_XOR;
}
function placePayload(frame, payload) {
  if (payload.buffer === frame.buffer && payload.byteOffset === frame.byteOffset + HEADER_SIZE) return;
  frame.set(payload, HEADER_SIZE);
}
function validatePayload(kind, payload) {
  const stride = BYTES_PER_LED[kind];
  if (payload.length === 0 || payload.length % stride !== 0) {
    throw new RangeError(`protocol: ${kind} payload must be a non-empty multiple of ${stride} bytes, got ${payload.length}`);
  }
  const count = payload.length / stride;
  if (count > MAX_LEDS) throw new RangeError(`protocol: ${kind} carries at most ${MAX_LEDS} LEDs, got ${count}`);
  return count;
}
function validateCalibration(calibration) {
  for (const key of ["limit", "red", "green", "blue"]) {
    const v = calibration[key];
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`protocol: calibration ${key} must be an integer in 0..255, got ${v}`);
    }
  }
}
function prepareOut(kind, out, size) {
  if (out === void 0) return new Uint8Array(size);
  if (out.length < size) throw new RangeError(`protocol: ${kind} frame needs ${size} bytes, output holds ${out.length}`);
  return out.length === size ? out : out.subarray(0, size);
}
var MAGIC0 = 0;
var MAGIC1 = 1;
var MAGIC2 = 2;
var HI = 3;
var LO = 4;
var CHK = 5;
var PAYLOAD = 6;
var CALIB = 7;
var TRAILER = 8;
var FrameParser = class {
  stats = { frames: 0, resyncs: 0, badChecksum: 0, countMismatch: 0 };
  maxLeds;
  state = MAGIC0;
  kind = "Ada";
  calibrated = false;
  hi = 0;
  lo = 0;
  count = 0;
  /** Payload bytes; `need` adds the calibration bytes, which share `scratch`. */
  payloadLength = 0;
  need = 0;
  filled = 0;
  trailerAt = 0;
  /**
   * Reused across frames and grown to the largest frame seen; the copy handed
   * out in `Frame.payload` is the one allocation per frame.
   */
  scratch = new Uint8Array(108 * 6 + CALIBRATION_SIZE);
  expected = new Uint8Array(TRAILER_SIZE);
  constructor(options = {}) {
    const maxLeds = options.maxLeds ?? MAX_LEDS;
    if (!Number.isInteger(maxLeds) || maxLeds < 1 || maxLeds > MAX_LEDS) {
      throw new RangeError(`protocol: maxLeds must be an integer 1..${MAX_LEDS}, got ${maxLeds}`);
    }
    this.maxLeds = maxLeds;
  }
  /** Back to hunting for magic; keeps the statistics. For a reopened port. */
  reset() {
    this.state = MAGIC0;
  }
  push(chunk) {
    const frames = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.state === PAYLOAD || this.state === CALIB) {
        const stop = this.state === PAYLOAD ? this.payloadLength : this.need;
        const take = Math.min(stop - this.filled, chunk.length - i);
        this.scratch.set(chunk.subarray(i, i + take), this.filled);
        this.filled += take;
        i += take;
        if (this.filled < stop) break;
        if (this.state === PAYLOAD) {
          if (this.kind === "Ada") {
            frames.push(this.emit());
            this.state = MAGIC0;
          } else {
            this.state = this.calibrated ? CALIB : TRAILER;
          }
        } else {
          this.state = TRAILER;
        }
        if (this.state === TRAILER) {
          fletcherInto(this.scratch, 0, this.need, this.expected, 0);
          this.trailerAt = 0;
        }
        continue;
      }
      const b = chunk[i];
      i++;
      switch (this.state) {
        case MAGIC0:
          if (b === MAGIC_A) this.state = MAGIC1;
          break;
        case MAGIC1:
          if (b === MAGIC_ADA_1) this.kind = "Ada";
          else if (b === MAGIC_AWA_1) this.kind = "Awa";
          else if (b === MAGIC_AFX_1) this.kind = "Afx";
          else {
            this.resync(b);
            break;
          }
          this.state = MAGIC2;
          break;
        case MAGIC2:
          if (this.kind === "Awa" && (b === MAGIC_AWA_2 || b === MAGIC_AWA_2_CALIBRATED)) {
            this.calibrated = b === MAGIC_AWA_2_CALIBRATED;
            this.state = HI;
          } else if (this.kind === "Ada" && b === MAGIC_ADA_2 || this.kind === "Afx" && b === MAGIC_AFX_2) {
            this.calibrated = false;
            this.state = HI;
          } else {
            this.resync(b);
          }
          break;
        case HI:
          this.hi = b;
          this.state = LO;
          break;
        case LO:
          this.lo = b;
          this.state = CHK;
          break;
        case CHK:
          if (b !== (this.hi ^ this.lo ^ HEADER_XOR)) {
            this.stats.countMismatch++;
            this.resync(b);
            break;
          }
          this.count = (this.hi << 8 | this.lo) + 1;
          if (this.count > this.maxLeds) {
            this.stats.countMismatch++;
            this.resync(b);
            break;
          }
          this.payloadLength = this.count * BYTES_PER_LED[this.kind];
          this.need = this.payloadLength + (this.calibrated ? CALIBRATION_SIZE : 0);
          if (this.scratch.length < this.need) this.scratch = new Uint8Array(this.need);
          this.filled = 0;
          this.state = PAYLOAD;
          break;
        case TRAILER:
          if (b !== this.expected[this.trailerAt]) {
            this.stats.badChecksum++;
            this.resync(b);
            break;
          }
          if (++this.trailerAt === TRAILER_SIZE) {
            frames.push(this.emit());
            this.state = MAGIC0;
          }
          break;
      }
    }
    return frames;
  }
  resync(b) {
    this.stats.resyncs++;
    this.state = b === MAGIC_A ? MAGIC1 : MAGIC0;
  }
  emit() {
    this.stats.frames++;
    const payload = this.scratch.slice(0, this.payloadLength);
    if (!this.calibrated) return { kind: this.kind, count: this.count, payload };
    const at = this.payloadLength;
    const s = this.scratch;
    return {
      kind: this.kind,
      count: this.count,
      payload,
      calibration: {
        limit: s[at],
        red: s[at + 1],
        green: s[at + 2],
        blue: s[at + 3]
      }
    };
  }
};

// lib/engine/control.ts
var TLV = Object.freeze({
  version: 1,
  runBench: 2,
  ledCount: 3,
  budgetMa: 4,
  idleBrightness: 5,
  benchOnBoot: 6,
  queryConfig: 7,
  save: 8,
  resetDefaults: 9,
  wifiSsid: 10,
  wifiPassphrase: 11,
  wifiEnabled: 12,
  queryNet: 13
});
var MAX_SSID_BYTES = 32;
var MIN_PASSPHRASE_BYTES = 8;
var MAX_PASSPHRASE_BYTES = 63;
var encoder = new TextEncoder();
function tlvAction(type) {
  return { type, value: new Uint8Array(0) };
}
function tlvU8(type, value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`control: ${type} takes 0..255, got ${String(value)}`);
  }
  return { type, value: Uint8Array.of(value) };
}
function tlvText(type, text, maxBytes) {
  const value = encoder.encode(text);
  if (value.length > maxBytes) {
    throw new RangeError(`control: ${value.length} bytes is over the ${maxBytes} the firmware accepts`);
  }
  if (value.includes(0)) throw new RangeError("control: a NUL cannot be sent in a text field");
  return { type, value };
}
function encodeControl(items) {
  if (items.length === 0) throw new RangeError("control: nothing to send");
  let length = 0;
  for (const item of items) {
    if (item.value.length > 255) {
      throw new RangeError(`control: a TLV value is at most 255 bytes, got ${item.value.length}`);
    }
    length += 2 + item.value.length;
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const item of items) {
    body[at] = item.type;
    body[at + 1] = item.value.length;
    body.set(item.value, at + 2);
    at += 2 + item.value.length;
  }
  return encodeAxc(body);
}
function wifiControl(credentials, save = true) {
  const ssid = tlvText(TLV.wifiSsid, credentials.ssid.trim(), MAX_SSID_BYTES);
  const passphrase = tlvText(TLV.wifiPassphrase, credentials.passphrase, MAX_PASSPHRASE_BYTES);
  if (passphrase.value.length !== 0 && (passphrase.value.length < MIN_PASSPHRASE_BYTES || passphrase.value.length > MAX_PASSPHRASE_BYTES)) {
    throw new RangeError(
      `control: a WPA2 passphrase is ${MIN_PASSPHRASE_BYTES}..${MAX_PASSPHRASE_BYTES} bytes, got ${passphrase.value.length}`
    );
  }
  if (credentials.enabled && ssid.value.length === 0) {
    throw new RangeError("control: a network cannot be joined without a name");
  }
  const items = [
    ssid,
    passphrase,
    tlvU8(TLV.wifiEnabled, credentials.enabled ? 1 : 0),
    // Saved, because credentials that do not survive a power cut are not
    // credentials - the board would come back on the cable only.
    ...save ? [tlvAction(TLV.save)] : [],
    tlvAction(TLV.queryNet)
  ];
  return encodeControl(items);
}
function queryControl() {
  return encodeControl([tlvAction(TLV.queryConfig), tlvAction(TLV.queryNet)]);
}

// lib/engine/decode.ts
function allocLinearGrid(width, height) {
  validateSize(width, height);
  return { width, height, data: new Float32Array(width * height * 3) };
}
function createRgbaDecoder(width, height) {
  validateSize(width, height);
  const lut = buildSrgbToLinearLut();
  const pixels = width * height;
  return {
    width,
    height,
    decode(rgba, out = allocLinearGrid(width, height)) {
      if (rgba.length !== pixels * 4) {
        throw new RangeError(`decode: ${rgba.length} bytes is not ${width}x${height} RGBA (${pixels * 4})`);
      }
      if (out.width !== width || out.height !== height || out.data.length < pixels * 3) {
        throw new RangeError(`decode: output grid is ${out.width}x${out.height}, decoder is ${width}x${height}`);
      }
      decodeRgba(rgba, lut, out.data, pixels);
      return out;
    }
  };
}
function decodeRgba(rgba, lut, out, pixels) {
  let src = 0;
  let dst = 0;
  for (let p = 0; p < pixels; p++) {
    out[dst] = lut[rgba[src]];
    out[dst + 1] = lut[rgba[src + 1]];
    out[dst + 2] = lut[rgba[src + 2]];
    src += 4;
    dst += 3;
  }
}
function validateSize(width, height) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError(`decode: grid size must be positive integers, got ${width}x${height}`);
  }
}

// lib/engine/encode.ts
function createFrameEncoder(format, leds, calibration) {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`encode: leds must be a positive integer, got ${String(leds)}`);
  }
  if (format !== "Afx" && format !== "Awa" && format !== "Ada") {
    throw new RangeError(`encode: unknown format ${String(format)}`);
  }
  if (calibration !== void 0 && format !== "Awa") {
    throw new RangeError(`encode: calibration is only carried by Awa, not ${format}`);
  }
  const calibrated = calibration !== void 0;
  const frameBytes = frameSize(format, leds, calibrated);
  const wire = new Uint8Array(frameBytes);
  const payloadBytes = leds * (format === "Afx" ? 6 : 3);
  const payload = wire.subarray(HEADER_SIZE, HEADER_SIZE + payloadBytes);
  return {
    format,
    leds,
    frameBytes,
    encode(colors) {
      if (colors.length < leds * 3) {
        throw new RangeError(`encode: colors holds ${colors.length} floats, needs ${leds * 3}`);
      }
      const view = colors.length === leds * 3 ? colors : colors.subarray(0, leds * 3);
      switch (format) {
        case "Afx":
          encodeLinear16(view, payload);
          return encodeAfx(payload, wire);
        case "Awa":
          encodeLinear8(view, payload);
          return encodeAwa(payload, calibration, wire);
        case "Ada":
          encodeLinear8(view, payload);
          return encodeAda(payload, wire);
      }
    }
  };
}

// lib/engine/wled.ts
var HEX = "0123456789ABCDEF";
function channel(value) {
  return Math.round(clamp01(value) * 255);
}
function hex2(value) {
  return `${HEX[value >> 4]}${HEX[value & 15]}`;
}
function wledFrame(colors, leds, options = {}) {
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`wled: leds must be a positive integer, got ${String(leds)}`);
  }
  if (colors.length < leds * 3) {
    throw new RangeError(`wled: colors holds ${colors.length} floats, needs ${leds * 3}`);
  }
  const segment = options.segment ?? 0;
  if (!Number.isInteger(segment) || segment < 0) {
    throw new RangeError(`wled: segment must be a non-negative integer, got ${String(segment)}`);
  }
  const encoding = options.encoding ?? "hex";
  const parts = [];
  for (let led = 0; led < leds; led++) {
    const at = led * 3;
    const r = channel(colors[at] ?? 0);
    const g = channel(colors[at + 1] ?? 0);
    const b = channel(colors[at + 2] ?? 0);
    parts.push(encoding === "hex" ? `"${hex2(r)}${hex2(g)}${hex2(b)}"` : `[${r},${g},${b}]`);
  }
  const body = `{"id":${segment},"i":[${parts.join(",")}]}`;
  return options.keepOn === false ? `{"seg":${body}}` : `{"on":true,"seg":${body}}`;
}
function wledHello(options = {}) {
  const segment = options.segment ?? 0;
  return `{"on":true,"live":true,"seg":{"id":${segment}}}`;
}
function wledUrl(host) {
  const trimmed = host.trim();
  if (trimmed === "") throw new RangeError("wled: host is empty");
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed.endsWith("/ws") ? trimmed : `${trimmed.replace(/\/+$/, "")}/ws`;
  }
  const bare = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const scheme = trimmed.startsWith("https://") ? "wss" : "ws";
  return `${scheme}://${bare}/ws`;
}

// lib/engine/net.ts
var SOCKET_OPEN = 1;
var DEFAULT_RETRY_MS = 1e3;
var DEFAULT_MAX_RETRY_MS = 15e3;
function defaultFactory(url) {
  const ctor = globalThis.WebSocket;
  if (ctor === void 0) throw new Error("net: this runtime has no WebSocket");
  return new ctor(url);
}
function connect(options, onOpen) {
  const factory = options.factory ?? defaultFactory;
  const baseRetry = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxRetry = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => {
    clearTimeout(handle);
  });
  let socket = null;
  let state = "idle";
  let retryMs = baseRetry;
  let timer = null;
  let closed = false;
  let connects = 0;
  let drops = 0;
  let closes = 0;
  const send = (data) => {
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      drops++;
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      drops++;
      return false;
    }
  };
  const open = () => {
    if (closed) return;
    state = "connecting";
    let next;
    try {
      next = factory(options.url);
    } catch {
      state = "error";
      retry();
      return;
    }
    socket = next;
    next.binaryType = "arraybuffer";
    next.onopen = () => {
      state = "open";
      connects++;
      retryMs = baseRetry;
      onOpen?.(send);
    };
    next.onclose = () => {
      closes++;
      if (socket === next) socket = null;
      if (!closed) {
        state = "connecting";
        retry();
      }
    };
    next.onerror = () => {
      state = "error";
    };
  };
  const retry = () => {
    if (closed || timer !== null) return;
    const delay = retryMs;
    retryMs = Math.min(maxRetry, retryMs * 2);
    timer = schedule(() => {
      timer = null;
      open();
    }, delay);
  };
  open();
  return {
    state: () => state,
    send,
    close() {
      closed = true;
      state = "idle";
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      try {
        current?.close();
      } catch {
      }
    },
    stats: () => ({ connects, drops, closes, retryMs })
  };
}
var AFX_PATH = "/afx";
function afxUrl(host) {
  const trimmed = host.trim();
  if (trimmed === "") throw new RangeError("net: host is empty");
  const scheme = trimmed.startsWith("wss://") || trimmed.startsWith("https://") ? "wss" : "ws";
  const bare = trimmed.replace(/^(wss?|https?):\/\//, "").replace(/\/+$/, "");
  if (bare === "") throw new RangeError("net: host is empty");
  const slash = bare.indexOf("/");
  return slash === -1 ? `${scheme}://${bare}${AFX_PATH}` : `${scheme}://${bare}`;
}
function createSocketSink(options) {
  const { encoder: encoder2 } = options;
  const link = connect(options);
  let sent = 0;
  return {
    kind: "websocket",
    describe: () => options.url,
    state: link.state,
    async send(colors) {
      const frame = encoder2.encode(colors);
      if (link.send(frame.slice())) sent++;
    },
    async sendBytes(raw) {
      if (!link.send(raw.slice())) throw new Error("net: the socket is not open");
    },
    async close() {
      link.close();
    },
    stats: () => ({ sent, format: encoder2.format, ...link.stats() })
  };
}
function createWledSink(options) {
  const { leds } = options;
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`net: leds must be a positive integer, got ${String(leds)}`);
  }
  const link = connect(options, (send) => {
    send(wledHello(options));
  });
  let sent = 0;
  let bytes = 0;
  return {
    kind: "wled",
    describe: () => options.url,
    state: link.state,
    async send(colors) {
      const text = wledFrame(colors, leds, options);
      if (link.send(text)) {
        sent++;
        bytes += text.length;
      }
    },
    async close() {
      link.close();
    },
    stats: () => ({ sent, bytes, leds, ...link.stats() })
  };
}

// lib/engine/effects.ts
var EFFECT_KINDS = [
  "rainbow",
  "blobs",
  "breathe",
  "candle",
  "comet",
  "police",
  "plasma"
];
function isEffectKind(value) {
  return typeof value === "string" && EFFECT_KINDS.includes(value);
}
var SPEED_MIN = 0.05;
var SPEED_MAX = 8;
var DEFAULT_SPEED = 1;
var DEFAULT_BRIGHTNESS = 1;
function effectGeometry(layout) {
  const count = layout.length;
  const centres = new Float32Array(Math.max(1, count) * 2);
  const along = new Float32Array(Math.max(1, count));
  if (count === 0) return { count: 0, centres, along };
  for (let i = 0; i < count; i++) {
    const rect = layout[i];
    centres[i * 2] = (rect.xMin + rect.xMax) / 2;
    centres[i * 2 + 1] = (rect.yMin + rect.yMax) / 2;
  }
  let total = 0;
  for (let i = 1; i < count; i++) {
    const dx = centres[i * 2] - centres[(i - 1) * 2];
    const dy = centres[i * 2 + 1] - centres[(i - 1) * 2 + 1];
    total += Math.hypot(dx, dy);
    along[i] = total;
  }
  const closing = count > 1 ? Math.hypot(
    centres[0] - centres[(count - 1) * 2],
    centres[1] - centres[(count - 1) * 2 + 1]
  ) : 0;
  const perimeter = total + closing;
  if (perimeter > 0) {
    for (let i = 0; i < count; i++) along[i] = along[i] / perimeter;
  }
  return { count, centres, along };
}
function hue(h, out, at, value = 1) {
  const t = (h % 1 + 1) % 1;
  const sector = t * 6;
  const c = Math.floor(sector);
  const f = sector - c;
  const rising = f;
  const falling = 1 - f;
  let r = 0;
  let g = 0;
  let b = 0;
  switch (c % 6) {
    case 0:
      r = 1;
      g = rising;
      break;
    case 1:
      r = falling;
      g = 1;
      break;
    case 2:
      g = 1;
      b = rising;
      break;
    case 3:
      g = falling;
      b = 1;
      break;
    case 4:
      r = rising;
      b = 1;
      break;
    default:
      r = 1;
      b = falling;
      break;
  }
  out[at] = srgbToLinear(r) * value;
  out[at + 1] = srgbToLinear(g) * value;
  out[at + 2] = srgbToLinear(b) * value;
}
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var clamp012 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function noiseTable(size, seed) {
  const random = seeded(seed);
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) table[i] = random();
  return table;
}
function noiseAt(table, t) {
  const size = table.length;
  const scaled = (t % size + size) % size;
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = table[i];
  const b = table[(i + 1) % size];
  const w = f * f * (3 - 2 * f);
  return a + (b - a) * w;
}
function createEffect(spec, geometry, clock2) {
  const speed = clampSpeed(spec.speed ?? DEFAULT_SPEED);
  const brightness = clamp012(spec.brightness ?? DEFAULT_BRIGHTNESS);
  const { count, centres, along } = geometry;
  const start = clock2();
  const flicker = noiseTable(64, 2654435769);
  const base = spec.color ?? { r: 255, g: 160, b: 60 };
  const baseLinear = new Float32Array([
    srgbToLinear(base.r / 255),
    srgbToLinear(base.g / 255),
    srgbToLinear(base.b / 255)
  ]);
  const scratch = new Float32Array(3);
  const render = (out, nowMs) => {
    const t = (nowMs - start) / 1e3 * speed;
    switch (spec.kind) {
      case "rainbow": {
        for (let i = 0; i < count; i++) {
          hue(along[i] - t * 0.1, out, i * 3, brightness);
        }
        break;
      }
      case "blobs": {
        for (let i = 0; i < count; i++) {
          const x = centres[i * 2];
          const y = centres[i * 2 + 1];
          let r = 0;
          let g = 0;
          let b = 0;
          for (let blob = 0; blob < 3; blob++) {
            const phase = t * 0.13 + blob * 2.1;
            const bx = 0.5 + 0.45 * Math.sin(phase * 1.07 + blob);
            const by = 0.5 + 0.45 * Math.cos(phase * 0.89 + blob * 1.7);
            const d = Math.hypot(x - bx, y - by);
            const weight = Math.exp(-(d * d) / 0.06);
            hue(blob / 3 + t * 0.03, scratch, 0, 1);
            r += scratch[0] * weight;
            g += scratch[1] * weight;
            b += scratch[2] * weight;
          }
          const at = i * 3;
          out[at] = clamp012(r) * brightness;
          out[at + 1] = clamp012(g) * brightness;
          out[at + 2] = clamp012(b) * brightness;
        }
        break;
      }
      case "breathe": {
        const level = (0.15 + 0.85 * (0.5 - 0.5 * Math.cos(t * 0.9))) * brightness;
        for (let i = 0; i < count; i++) {
          const at = i * 3;
          out[at] = baseLinear[0] * level;
          out[at + 1] = baseLinear[1] * level;
          out[at + 2] = baseLinear[2] * level;
        }
        break;
      }
      case "candle": {
        for (let i = 0; i < count; i++) {
          const n = noiseAt(flicker, t * 3 + i * 0.7);
          const level = (0.45 + 0.55 * n) * brightness;
          const at = i * 3;
          out[at] = baseLinear[0] * level;
          out[at + 1] = baseLinear[1] * level * (0.75 + 0.25 * n);
          out[at + 2] = baseLinear[2] * level * (0.4 + 0.6 * n * n);
        }
        break;
      }
      case "comet": {
        const head = (t * 0.35 % 1 + 1) % 1;
        for (let i = 0; i < count; i++) {
          let d = head - along[i];
          if (d < 0) d += 1;
          const level = Math.exp(-d / 0.12) * brightness;
          const at = i * 3;
          out[at] = baseLinear[0] * level;
          out[at + 1] = baseLinear[1] * level;
          out[at + 2] = baseLinear[2] * level;
        }
        break;
      }
      case "police": {
        const phase = Math.floor(t * 2) % 2 === 0;
        for (let i = 0; i < count; i++) {
          const left = centres[i * 2] < 0.5;
          const on = left === phase;
          const at = i * 3;
          out[at] = on && left ? brightness : 0;
          out[at + 1] = 0;
          out[at + 2] = on && !left ? brightness : 0;
        }
        break;
      }
      default: {
        for (let i = 0; i < count; i++) {
          const x = centres[i * 2];
          const y = centres[i * 2 + 1];
          const v = Math.sin(x * 6 + t * 0.7) + Math.sin(y * 5 - t * 0.53) + Math.sin((x + y) * 4 + t * 0.31);
          hue(v / 6 + 0.5, out, i * 3, brightness);
        }
        break;
      }
    }
  };
  return { kind: spec.kind, render };
}
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
    spec.color = { r: channel2(color.r), g: channel2(color.g), b: channel2(color.b) };
  }
  return spec;
}
function channel2(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`effects: a colour channel is an integer 0..255, got ${String(value)}`);
  }
  return value;
}

// lib/engine/patterns.ts
var PATTERN_KINDS = ["walk", "solid", "ramp", "flash", "off"];
function isPatternKind(value) {
  return typeof value === "string" && PATTERN_KINDS.includes(value);
}
var WALK_LEDS_PER_SECOND = 5;
var FLASH_HZ = 1;
var RAMP_STEPS = 21;
function fill(out, count, r, g, b) {
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
  }
}
function createPattern(spec, count, clock2) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`patterns: count must be a positive integer, got ${String(count)}`);
  }
  if (!isPatternKind(spec.kind)) {
    throw new RangeError(`patterns: unknown kind ${String(spec.kind)}`);
  }
  const started = clock2();
  const colour = spec.color ?? { r: 1, g: 1, b: 1 };
  const perSecond = spec.ledsPerSecond ?? WALK_LEDS_PER_SECOND;
  if (!(perSecond > 0)) {
    throw new RangeError(`patterns: ledsPerSecond must be positive, got ${String(perSecond)}`);
  }
  const hz = spec.hz ?? FLASH_HZ;
  if (!(hz > 0)) throw new RangeError(`patterns: hz must be positive, got ${String(hz)}`);
  const ramp = new Float32Array(RAMP_STEPS);
  for (let i = 0; i < RAMP_STEPS; i++) ramp[i] = srgbToLinear(i / (RAMP_STEPS - 1));
  const render = (out, now) => {
    if (out.length < count * 3) {
      throw new RangeError(`patterns: out holds ${out.length} floats, needs ${count * 3}`);
    }
    const elapsed = Math.max(0, now - started) / 1e3;
    switch (spec.kind) {
      case "off":
        fill(out, count, 0, 0, 0);
        return;
      case "solid":
        fill(out, count, colour.r, colour.g, colour.b);
        return;
      case "walk": {
        fill(out, count, 0, 0, 0);
        const at = Math.floor(elapsed * perSecond) % count;
        const base = at * 3;
        out[base] = 1;
        out[base + 1] = 1;
        out[base + 2] = 1;
        return;
      }
      case "ramp": {
        for (let i = 0; i < count; i++) {
          const step = Math.min(RAMP_STEPS - 1, Math.floor(i / count * RAMP_STEPS));
          const v = ramp[step] ?? 0;
          const at = i * 3;
          out[at] = v;
          out[at + 1] = v;
          out[at + 2] = v;
        }
        return;
      }
      case "flash": {
        const on = elapsed * hz % 1 < 0.5;
        const v = on ? 1 : 0;
        fill(out, count, v, v, v);
      }
    }
  };
  return { kind: spec.kind, render };
}
function parsePatternSpec(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("patterns: spec must be an object");
  }
  const raw = value;
  if (!isPatternKind(raw.kind)) {
    throw new RangeError(`patterns: unknown kind ${String(raw.kind)}`);
  }
  const spec = { kind: raw.kind };
  if (raw.color !== void 0) {
    const colour = raw.color;
    if (typeof colour !== "object" || colour === null) throw new TypeError("patterns: color must be an object");
    const channels = ["r", "g", "b"];
    const parsed = { r: 0, g: 0, b: 0 };
    for (const channel3 of channels) {
      const v = colour[channel3];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new RangeError(`patterns: color.${channel3} must be a number in 0..1, got ${String(v)}`);
      }
      parsed[channel3] = v;
    }
    spec.color = parsed;
  }
  for (const key of ["ledsPerSecond", "hz"]) {
    const v = raw[key];
    if (v === void 0) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new RangeError(`patterns: ${key} must be a positive number, got ${String(v)}`);
    }
    spec[key] = v;
  }
  return spec;
}
var WIZARD_COLORS = Object.freeze({
  red: Object.freeze({ r: 1, g: 0, b: 0 }),
  green: Object.freeze({ r: 0, g: 1, b: 0 }),
  blue: Object.freeze({ r: 0, g: 0, b: 1 })
});

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
var LARGE_REGION_PIXELS = 1600;
var MAX_ACCURACY_LEVEL = 4;
var KMEANS_CONVERGENCE = 1 / 255;
var KMEANS_MAX_ITERATIONS = 20;
var CLUSTER_SEEDS = Object.freeze([
  Object.freeze({ r: 0, g: 0, b: 0 }),
  Object.freeze({ r: 0, g: 1, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 1 }),
  Object.freeze({ r: 1, g: 0, b: 0 }),
  Object.freeze({ r: 1, g: 1, b: 0 })
]);
var DOMINANT_LEVELS = 32;
function createSampler(options) {
  return new LedSampler(options);
}
var NAMED_LEDS_IN_WARNING = 8;
var LedSampler = class {
  width;
  height;
  count;
  warnings = [];
  rects;
  /** Pixels stepped along each axis: reducedPixelSetFactor + 1 (.cpp:83). */
  step;
  clusterCount;
  /** How many leading entries of `warnings` were produced at construction and survive every rebuild. */
  fixedWarnings;
  currentBorder = NO_BORDER;
  /** `starts[led] .. starts[led + 1]` is LED `led`'s slice of `indices`. */
  starts;
  /** Every LED's pixel offsets back to back. Grows when a rebuild needs more, never shrinks. */
  indices = new Int32Array(0);
  /** Rebuild scratch, five ints per LED: minX, endX, minY, endY, step. */
  bounds;
  /** Rebuild scratch: the first few LEDs the large-region guard fired on. */
  forced = new Int32Array(NAMED_LEDS_IN_WARNING);
  // Scratch for the modes that need it, allocated on first use so a sampler
  // that only ever runs `mean` pays for none of it.
  /** The identity map 0..width*height-1: the "region" of the unicolor modes. */
  wholeGrid = null;
  /** 32^3 bin counts for `dominant`, zero between calls. */
  histogram = null;
  /** The bin of each pixel of the region in hand, so the winning bin can be averaged and the histogram cleared without recomputing keys. */
  keys = null;
  centroids = new Float64Array(CLUSTER_SEEDS.length * 3);
  sums = new Float64Array(CLUSTER_SEEDS.length * 3);
  members = new Int32Array(CLUSTER_SEEDS.length);
  constructor(options) {
    const { width, height, layout } = options;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`sample: grid must be at least 1x1, got ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.rects = layout.map(validateRect);
    this.count = this.rects.length;
    const factor = options.reducedPixelSetFactor ?? SAMPLER_DEFAULTS.reducedPixelSetFactor;
    if (!Number.isInteger(factor) || factor < 0 || factor > 3) {
      throw new RangeError(`sample: reducedPixelSetFactor must be an integer in 0..3, got ${factor}`);
    }
    this.step = factor + 1;
    let accuracy = options.accuracyLevel ?? SAMPLER_DEFAULTS.accuracyLevel;
    if (!Number.isInteger(accuracy)) throw new RangeError(`sample: accuracyLevel must be an integer, got ${accuracy}`);
    if (accuracy > MAX_ACCURACY_LEVEL) {
      this.warnings.push(`sample: accuracyLevel ${accuracy} is above the maximum ${MAX_ACCURACY_LEVEL}; using ${MAX_ACCURACY_LEVEL}`);
      accuracy = MAX_ACCURACY_LEVEL;
    } else if (accuracy < 0) {
      this.warnings.push(`sample: accuracyLevel ${accuracy} is below 0; using 0`);
      accuracy = 0;
    }
    this.clusterCount = accuracy + 1;
    this.fixedWarnings = this.warnings.length;
    this.starts = new Int32Array(this.count + 1);
    this.bounds = new Int32Array(this.count * 5);
    this.rebuild(0, 0);
  }
  border() {
    return this.currentBorder;
  }
  setBorder(border2) {
    const leftRight = border2.unknown ? 0 : border2.leftRight;
    const topBottom = border2.unknown ? 0 : border2.topBottom;
    if (!Number.isInteger(leftRight) || !Number.isInteger(topBottom) || leftRight < 0 || topBottom < 0) {
      throw new RangeError(`sample: border insets must be non-negative integers, got ${leftRight}/${topBottom}`);
    }
    if (2 * leftRight >= this.width || 2 * topBottom >= this.height) {
      throw new RangeError(`sample: border ${leftRight}/${topBottom} leaves no picture on a ${this.width}x${this.height} grid`);
    }
    if (leftRight === this.currentBorder.leftRight && topBottom === this.currentBorder.topBottom) return false;
    this.rebuild(leftRight, topBottom);
    return true;
  }
  pixelIndices(led) {
    if (!Number.isInteger(led) || led < 0 || led >= this.count) throw new RangeError(`sample: no LED ${led} in a layout of ${this.count}`);
    return this.indices.subarray(this.starts[led], this.starts[led + 1]);
  }
  sample(grid, out, mode) {
    const { width, height, count } = this;
    if (grid.width !== width || grid.height !== height) {
      throw new RangeError(`sample: grid is ${grid.width}x${grid.height}, the map was built for ${width}x${height}`);
    }
    if (grid.data.length < width * height * 3) {
      throw new RangeError(`sample: grid data holds ${grid.data.length} floats, ${width}x${height} needs ${width * height * 3}`);
    }
    if (out.length < count * 3) throw new RangeError(`sample: out holds ${out.length} floats, ${count} LEDs need ${count * 3}`);
    const data = grid.data;
    const starts = this.starts;
    const indices = this.indices;
    switch (mode) {
      case "mean":
        for (let led = 0; led < count; led++) this.meanInto(data, indices, starts[led], starts[led + 1], out, led * 3);
        break;
      case "meanSquared":
        for (let led = 0; led < count; led++) this.meanSquaredInto(data, indices, starts[led], starts[led + 1], out, led * 3);
        break;
      case "dominant":
        for (let led = 0; led < count; led++) this.dominantInto(data, indices, starts[led], starts[led + 1], out, led * 3);
        break;
      case "dominantAdvanced":
        for (let led = 0; led < count; led++) this.kMeansInto(data, indices, starts[led], starts[led + 1], out, led * 3);
        break;
      case "unicolorMean": {
        const all = this.allPixels();
        this.meanInto(data, all, 0, all.length, out, 0);
        fillFromFirst(out, count);
        break;
      }
      case "unicolorDominant": {
        const all = this.allPixels();
        this.dominantInto(data, all, 0, all.length, out, 0);
        fillFromFirst(out, count);
        break;
      }
      case "unicolorDominantAdvanced": {
        const all = this.allPixels();
        this.kMeansInto(data, all, 0, all.length, out, 0);
        fillFromFirst(out, count);
        break;
      }
      default:
        throw new RangeError(`sample: unknown mode ${String(mode)}`);
    }
    return out;
  }
  /**
   * Port of the constructor's index loop (.cpp:39-111), run again for every
   * border. Two passes: the first computes each LED's pixel box and the size
   * of the map, the second fills it, so the one buffer grows at most once
   * per size and there is nothing to allocate per pixel.
   */
  rebuild(leftRight, topBottom) {
    const { width, height, count, rects, starts, bounds, forced } = this;
    this.warnings.length = this.fixedWarnings;
    this.currentBorder = Object.freeze({ unknown: false, leftRight, topBottom });
    const xOffset = leftRight;
    const activeW = width - 2 * leftRight;
    const yOffset = topBottom;
    const activeH = height - 2 * topBottom;
    let total = 0;
    let forcedCount = 0;
    for (let led = 0; led < count; led++) {
      const rect = rects[led];
      const b = led * 5;
      if (rect.xMax - rect.xMin < 1e-6 || rect.yMax - rect.yMin < 1e-6) {
        bounds[b] = 0;
        bounds[b + 1] = 0;
        bounds[b + 2] = 0;
        bounds[b + 3] = 0;
        bounds[b + 4] = 1;
        continue;
      }
      let minX = xOffset + Math.round(activeW * rect.xMin);
      let maxX = xOffset + Math.round(activeW * rect.xMax);
      let minY = yOffset + Math.round(activeH * rect.yMin);
      let maxY = yOffset + Math.round(activeH * rect.yMax);
      minX = Math.min(minX, xOffset + activeW - 1);
      if (minX === maxX) maxX++;
      minY = Math.min(minY, yOffset + activeH - 1);
      if (minY === maxY) maxY++;
      const endX = Math.min(maxX, xOffset + activeW);
      const endY = Math.min(maxY, yOffset + activeH);
      let step = this.step;
      if (step === 1 && (endY - minY) * (endX - minX) > LARGE_REGION_PIXELS) {
        step = 2;
        if (forcedCount < forced.length) forced[forcedCount] = led;
        forcedCount++;
      }
      bounds[b] = minX;
      bounds[b + 1] = endX;
      bounds[b + 2] = minY;
      bounds[b + 3] = endY;
      bounds[b + 4] = step;
      total += Math.ceil((endY - minY) / step) * Math.ceil((endX - minX) / step);
    }
    if (total > this.indices.length) this.indices = new Int32Array(total);
    const indices = this.indices;
    let n = 0;
    for (let led = 0; led < count; led++) {
      const b = led * 5;
      const minX = bounds[b];
      const endX = bounds[b + 1];
      const endY = bounds[b + 3];
      const step = bounds[b + 4];
      starts[led] = n;
      for (let y = bounds[b + 2]; y < endY; y += step) {
        for (let x = minX; x < endX; x += step) indices[n++] = y * width + x;
      }
    }
    starts[count] = n;
    if (forcedCount > 0) {
      const named = Array.from(forced.subarray(0, Math.min(forcedCount, forced.length))).join(", ");
      const more = forcedCount > forced.length ? ` and ${forcedCount - forced.length} more` : "";
      this.warnings.push(
        `sample: ${forcedCount} LED region(s) exceed ${LARGE_REGION_PIXELS} pixels (LED ${named}${more}); every 2nd pixel is skipped for them. Set reducedPixelSetFactor to choose the reduction yourself.`
      );
    }
  }
  allPixels() {
    if (this.wholeGrid === null) {
      const all = new Int32Array(this.width * this.height);
      for (let i = 0; i < all.length; i++) all[i] = i;
      this.wholeGrid = all;
    }
    return this.wholeGrid;
  }
  /**
   * .h:409-439 in floats. The float sum of linear values divided by the count
   * is the area average of the light; Hyperion's `uint8_t(cumm / pixelNum)`
   * truncates, and its accumulator is wide enough only for regions under
   * about 16 million pixels (defect #5 is the squared variant, which is not).
   */
  meanInto(data, idx, from, to, out, o) {
    const n = to - from;
    if (n === 0) {
      black(out, o);
      return;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = from; i < to; i++) {
      const p = idx[i] * 3;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
    }
    out[o] = r / n;
    out[o + 1] = g / n;
    out[o + 2] = b / n;
  }
  /**
   * .h:488-524: root of the mean of the squares, per channel. Hyperion divides
   * the integer sum before the sqrt and overflows a 32-bit accumulator past
   * ~66 000 pixels (.h:508, .h:518; defect #5); floats have neither problem.
   * On linear input the result is simply biased towards the bright pixels.
   */
  meanSquaredInto(data, idx, from, to, out, o) {
    const n = to - from;
    if (n === 0) {
      black(out, o);
      return;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = from; i < to; i++) {
      const p = idx[i] * 3;
      const pr = data[p];
      const pg = data[p + 1];
      const pb = data[p + 2];
      r += pr * pr;
      g += pg * pg;
      b += pb * pb;
    }
    out[o] = Math.sqrt(r / n);
    out[o + 1] = Math.sqrt(g / n);
    out[o + 2] = Math.sqrt(b / n);
  }
  /**
   * .h:572-605 on quantised keys. Three passes over the region: count the
   * bins and find the winner, average the pixels that fell into it, zero
   * the touched bins. The histogram stays allocated and zero between calls,
   * which is what makes the clear cost O(region) rather than O(32^3).
   */
  dominantInto(data, idx, from, to, out, o) {
    const n = to - from;
    if (n === 0) {
      black(out, o);
      return;
    }
    const histogram = this.histogram ??= new Int32Array(DOMINANT_LEVELS * DOMINANT_LEVELS * DOMINANT_LEVELS);
    const keys = this.keys ??= new Int32Array(this.width * this.height);
    let best = 0;
    let bestCount = 0;
    for (let i = from; i < to; i++) {
      const p = idx[i] * 3;
      const key = quantise(data[p]) << 10 | quantise(data[p + 1]) << 5 | quantise(data[p + 2]);
      keys[i - from] = key;
      const c = histogram[key] + 1;
      histogram[key] = c;
      if (c > bestCount) {
        bestCount = c;
        best = key;
      }
    }
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = from; i < to; i++) {
      if (keys[i - from] !== best) continue;
      const p = idx[i] * 3;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
    }
    out[o] = r / bestCount;
    out[o + 1] = g / bestCount;
    out[o + 2] = b / bestCount;
    for (let i = 0; i < n; i++) histogram[keys[i]] = 0;
  }
  /**
   * .h:653-744, Lloyd's k-means from fixed seeds. Per iteration: assign every
   * pixel to the nearest centroid, move every populated centroid to the mean
   * of its pixels, stop when the largest move is under `KMEANS_CONVERGENCE`
   * or the cap is reached. The answer is the centroid of the most-populated
   * cluster after the last update, which is what Hyperion returns too
   * (.h:725-740).
   */
  kMeansInto(data, idx, from, to, out, o) {
    if (from === to) {
      black(out, o);
      return;
    }
    const k = this.clusterCount;
    const c = this.centroids;
    const s = this.sums;
    const m = this.members;
    for (let j = 0; j < k; j++) {
      const seed = CLUSTER_SEEDS[j];
      c[j * 3] = seed.r;
      c[j * 3 + 1] = seed.g;
      c[j * 3 + 2] = seed.b;
    }
    let dominant = 0;
    for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration++) {
      s.fill(0, 0, k * 3);
      m.fill(0, 0, k);
      for (let i = from; i < to; i++) {
        const p = idx[i] * 3;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        let best = 0;
        let bestDistance = Infinity;
        for (let j = 0; j < k; j++) {
          const dr = r - c[j * 3];
          const dg = g - c[j * 3 + 1];
          const db = b - c[j * 3 + 2];
          const distance = dr * dr + dg * dg + db * db;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = j;
          }
        }
        s[best * 3] = s[best * 3] + r;
        s[best * 3 + 1] = s[best * 3 + 1] + g;
        s[best * 3 + 2] = s[best * 3 + 2] + b;
        m[best] = m[best] + 1;
      }
      let maxMove = 0;
      dominant = 0;
      for (let j = 0; j < k; j++) {
        const n = m[j];
        if (n === 0) continue;
        const nr = s[j * 3] / n;
        const ng = s[j * 3 + 1] / n;
        const nb = s[j * 3 + 2] / n;
        const dr = nr - c[j * 3];
        const dg = ng - c[j * 3 + 1];
        const db = nb - c[j * 3 + 2];
        const move = Math.sqrt(dr * dr + dg * dg + db * db);
        if (move > maxMove) maxMove = move;
        c[j * 3] = nr;
        c[j * 3 + 1] = ng;
        c[j * 3 + 2] = nb;
        if (n > m[dominant]) dominant = j;
      }
      if (maxMove < KMEANS_CONVERGENCE) break;
    }
    out[o] = c[dominant * 3];
    out[o + 1] = c[dominant * 3 + 1];
    out[o + 2] = c[dominant * 3 + 2];
  }
};
function quantise(v) {
  return v <= 0 ? 0 : v >= 1 ? DOMINANT_LEVELS - 1 : Math.round(v * (DOMINANT_LEVELS - 1));
}
function black(out, o) {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
}
function fillFromFirst(out, count) {
  const r = out[0];
  const g = out[1];
  const b = out[2];
  for (let led = 1; led < count; led++) {
    out[led * 3] = r;
    out[led * 3 + 1] = g;
    out[led * 3 + 2] = b;
  }
}
function validateRect(rect, led) {
  for (const edge of ["xMin", "xMax", "yMin", "yMax"]) {
    const v = rect[edge];
    if (!(v >= 0 && v <= 1)) throw new RangeError(`sample: LED ${led} ${edge} must be in [0, 1], got ${v}`);
  }
  return Object.freeze({ xMin: rect.xMin, xMax: rect.xMax, yMin: rect.yMin, yMax: rect.yMax });
}

// lib/engine/sink.ts
function createFrameWriter(sink, options = {}) {
  const onError = options.onError;
  let owned = new Float32Array(0);
  let inFlight = null;
  let written = 0;
  let dropped = 0;
  let errors = 0;
  return {
    send(colors) {
      if (inFlight !== null) {
        dropped++;
        return false;
      }
      if (owned.length !== colors.length) owned = new Float32Array(colors.length);
      owned.set(colors);
      let pending;
      try {
        pending = sink.send(owned);
      } catch (error) {
        pending = Promise.reject(error);
      }
      inFlight = pending.then(
        () => {
          written++;
        },
        (error) => {
          errors++;
          onError?.(error);
        }
      ).finally(() => {
        inFlight = null;
      });
      return true;
    },
    stats() {
      return { written, dropped, errors, inFlight: inFlight !== null };
    },
    idle() {
      return inFlight ?? Promise.resolve();
    }
  };
}
function createBytesSink(options) {
  const { kind, label, encoder: encoder2, transport } = options;
  let state = "open";
  let bytes = 0;
  return {
    kind,
    describe: () => label,
    state: () => state,
    async send(colors) {
      const frame = encoder2.encode(colors);
      try {
        await transport.write(frame);
      } catch (error) {
        state = "error";
        throw error;
      }
      bytes += frame.length;
    },
    async sendBytes(raw) {
      await transport.write(raw);
    },
    async close() {
      state = "idle";
      await transport.close?.();
    },
    stats: () => ({ bytes, format: encoder2.format, frameBytes: encoder2.frameBytes })
  };
}
function createLoopbackSink(options) {
  const { encoder: encoder2 } = options;
  const latencyMs = options.latencyMs ?? 0;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const parser = new FrameParser();
  let accepted = 0;
  let rejected = 0;
  let bytes = 0;
  let lastPayload = null;
  return {
    kind: "loopback",
    describe: () => "loopback",
    state: () => "open",
    async send(colors) {
      const frame = encoder2.encode(colors);
      bytes += frame.length;
      const frames = parser.push(frame);
      if (frames.length === 0) {
        rejected++;
      } else {
        accepted += frames.length;
        lastPayload = frames[frames.length - 1].payload;
      }
      if (latencyMs > 0) await wait(latencyMs);
    },
    async close() {
    },
    stats: () => ({ accepted, rejected, bytes }),
    loopback: () => ({ accepted, rejected, bytes, parser: { ...parser.stats }, lastPayload })
  };
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
var TIME_EPS = 1e-6;
var Cadence = class {
  period;
  nextDue = null;
  lastTaken = -Infinity;
  constructor(period) {
    this.period = period;
  }
  /** True when a slot is open at `now`, and takes it. */
  take(now) {
    if (this.nextDue !== null && now + TIME_EPS < this.nextDue) return false;
    if (now - this.lastTaken < this.period / 2) return false;
    this.nextDue = this.nextDue === null || now - this.nextDue >= this.period ? now + this.period : this.nextDue + this.period;
    this.lastTaken = now;
    return true;
  }
};
function decayWeight(decay, s, t) {
  if (decay === 1) return t - s;
  return (decay + 1) * (Math.pow(t, decay) - Math.pow(s, decay));
}
function createSmoother(options, clock2) {
  switch (options.mode) {
    case "linear":
      return new LinearSmoother(options, clock2);
    case "decay":
      return new DecaySmoother(options, clock2);
    case "asymmetric":
      return new AsymmetricSmoother(options, clock2);
    default:
      throw new RangeError(`smooth: unknown mode ${String(options.mode)}`);
  }
}
var SmootherBase = class {
  clock;
  outputHz;
  ledCount;
  /** Where the output is now. Float32 so the emitted frame is bit-identical to it. */
  state;
  target;
  /** Time the current target arrived; null before the first `setTarget`. */
  targetSetTime = null;
  /** Time of the last emitted frame; null before the first. */
  lastEmit = null;
  output;
  out;
  constructor(options, clock2) {
    this.clock = clock2;
    this.outputHz = options.outputHz ?? SMOOTHING_DEFAULTS.outputHz;
    requirePositive("outputHz", this.outputHz);
    this.output = new Cadence(1e3 / this.outputHz);
    this.ledCount = validateCount(options.count);
    this.state = allocLedColors(this.ledCount);
    this.target = allocLedColors(this.ledCount);
    this.out = allocLedColors(this.ledCount);
  }
  get count() {
    return this.ledCount;
  }
  setTarget(colors, now = this.clock()) {
    if (colors.length !== this.ledCount * 3) {
      if (colors.length % 3 !== 0) throw new RangeError(`smooth: frame length ${colors.length} is not a multiple of 3`);
      this.reset(colors.length / 3);
    }
    let changed = this.targetSetTime === null;
    if (!changed) {
      const target = this.target;
      for (let i = 0; i < target.length; i++) {
        if (target[i] !== colors[i]) {
          changed = true;
          break;
        }
      }
    }
    this.target.set(colors);
    this.targetSetTime = now;
    this.onTarget(now, changed);
  }
  tick(now = this.clock()) {
    this.observe(now);
    if (!this.output.take(now)) return null;
    this.advance(now);
    this.out.set(this.state);
    this.lastEmit = now;
    return this.out;
  }
  current() {
    return this.out;
  }
  reset(count = this.ledCount) {
    this.ledCount = validateCount(count);
    this.state = allocLedColors(this.ledCount);
    this.target = allocLedColors(this.ledCount);
    this.out = allocLedColors(this.ledCount);
    this.targetSetTime = null;
    this.lastEmit = null;
    this.onReset();
  }
  /** Called after a new target is stored; `changed` is false for a repeat of the previous one. Must not move `state`. */
  onTarget(_now, _changed) {
  }
  /** Called on every tick, emitting or not. */
  observe(_now) {
  }
  onReset() {
  }
};
var LinearSmoother = class extends SmootherBase {
  mode = "linear";
  settlingMs;
  minStep;
  targetTime = -Infinity;
  constructor(options, clock2) {
    super(options, clock2);
    this.settlingMs = options.settlingMs ?? SMOOTHING_DEFAULTS.settlingMs;
    this.minStep = options.minStep ?? SMOOTHING_DEFAULTS.minStep;
    requireNonNegative("settlingMs", this.settlingMs);
    requirePositive("minStep", this.minStep);
  }
  onTarget(now, changed) {
    if (changed) this.targetTime = now + this.settlingMs;
  }
  advance(now) {
    const { state, target } = this;
    if (now >= this.targetTime) {
      state.set(target);
      return;
    }
    const previousWrite = this.lastEmit ?? this.targetSetTime ?? now;
    const span = this.targetTime - previousWrite;
    let k = span > 0 ? 1 - (this.targetTime - now) / span : 1;
    if (k < 0) k = 0;
    else if (k > 1) k = 1;
    const minStep = this.minStep;
    for (let i = 0; i < state.length; i++) {
      const prev = state[i];
      const goal = target[i];
      const diff = goal - prev;
      if (diff === 0) continue;
      const distance = Math.abs(diff);
      let step = k * distance;
      if (step < minStep) step = minStep;
      if (step > distance) step = distance;
      let next = diff < 0 ? prev - step : prev + step;
      if (Math.fround(next) === prev) {
        next = nudgeFloat32(prev, goal);
        if (diff < 0 ? next < goal : next > goal) next = goal;
      }
      state[i] = next;
    }
  }
};
function nudgeFloat32(value, towards) {
  const magnitude = Math.abs(value);
  const ulp = magnitude === 0 ? 2 ** -149 : 2 ** (Math.floor(Math.log2(magnitude)) - 23);
  return towards > value ? value + ulp : value - ulp;
}
var DecaySmoother = class extends SmootherBase {
  mode = "decay";
  window;
  decay;
  interpolation;
  normalizePartialWindow;
  history = [];
  /** Buffers of pruned frames, reused so a 120 Hz input does not churn the heap. */
  pool = [];
  /** Float64 accumulator: the sum is over up to hundreds of frames and Float32 would lose the small weights. */
  acc;
  constructor(options, clock2) {
    super(options, clock2);
    this.window = options.settlingMs ?? SMOOTHING_DEFAULTS.settlingMs;
    this.decay = options.decay ?? SMOOTHING_DEFAULTS.decay;
    const interpolationHz = options.interpolationHz ?? this.outputHz;
    this.normalizePartialWindow = options.normalizePartialWindow ?? false;
    requirePositive("settlingMs", this.window);
    if (!(this.decay >= 1) || !Number.isFinite(this.decay)) throw new RangeError(`smooth: decay must be a finite number of at least 1, got ${this.decay}`);
    requirePositive("interpolationHz", interpolationHz);
    this.interpolation = new Cadence(1e3 / interpolationHz);
    this.acc = new Float64Array(this.ledCount * 3);
  }
  onTarget(now, _changed) {
    const windowStart = now - this.window;
    let stale = -1;
    for (const frame of this.history) {
      if (frame.time >= windowStart) break;
      stale++;
    }
    if (stale > 0) {
      for (const frame of this.history.splice(0, stale)) this.pool.push(frame.colors);
    }
    const colors = this.pool.pop() ?? allocLedColors(this.ledCount);
    colors.set(this.target);
    this.history.push({ time: now, colors });
  }
  observe(now) {
    if (this.interpolation.take(now)) this.interpolate(now);
  }
  advance(_now) {
  }
  onReset() {
    this.history = [];
    this.pool = [];
    this.acc = new Float64Array(this.ledCount * 3);
  }
  /** Port of `interpolateFrame` (cpp:375-425). */
  interpolate(now) {
    const { acc, history, window, decay } = this;
    const windowStart = now - window;
    acc.fill(0);
    let fs = 0;
    let frameEnd = now;
    for (let i = history.length - 1; i >= 0 && frameEnd > windowStart; i--) {
      const frame = history[i];
      let frameStart = frame.time > windowStart ? frame.time : windowStart;
      if (frameStart > frameEnd) frameStart = frameEnd;
      const weight = decayWeight(decay, (frameStart - windowStart) / window, (frameEnd - windowStart) / window);
      fs += weight;
      if (weight > 0) {
        const colors = frame.colors;
        for (let c = 0; c < acc.length; c++) acc[c] = acc[c] + weight * colors[c];
      }
      frameEnd = frameStart;
    }
    let divisor;
    if (this.normalizePartialWindow) divisor = fs > 0 ? fs : 1;
    else divisor = fs < 1 ? 1 : fs;
    const state = this.state;
    for (let c = 0; c < state.length; c++) state[c] = acc[c] / divisor;
  }
};
var AsymmetricSmoother = class extends SmootherBase {
  mode = "asymmetric";
  attackMs;
  releaseMs;
  absFloor;
  relFloor;
  cutThreshold;
  /** The deadbanded target the output heads for. */
  accepted;
  constructor(options, clock2) {
    super(options, clock2);
    this.attackMs = options.attackMs ?? SMOOTHING_DEFAULTS.attackMs;
    this.releaseMs = options.releaseMs ?? SMOOTHING_DEFAULTS.releaseMs;
    this.absFloor = options.absFloor ?? SMOOTHING_DEFAULTS.absFloor;
    this.relFloor = options.relFloor ?? SMOOTHING_DEFAULTS.relFloor;
    this.cutThreshold = options.cutThreshold ?? SMOOTHING_DEFAULTS.cutThreshold;
    requirePositive("attackMs", this.attackMs);
    requirePositive("releaseMs", this.releaseMs);
    requireNonNegative("absFloor", this.absFloor);
    requireNonNegative("relFloor", this.relFloor);
    requireNonNegative("cutThreshold", this.cutThreshold);
    this.accepted = allocLedColors(this.ledCount);
  }
  onTarget(_now, _changed) {
    const { target, accepted, absFloor, relFloor } = this;
    for (let i = 0; i < target.length; i++) {
      const x = target[i];
      if (!Number.isFinite(x)) continue;
      const a = accepted[i];
      const diff = x - a;
      const eps = Math.max(absFloor, relFloor * a);
      if (diff < eps && diff > -eps) continue;
      accepted[i] = x;
    }
  }
  onReset() {
    this.accepted = allocLedColors(this.ledCount);
  }
  advance(now) {
    const { state, accepted, absFloor } = this;
    let totalDistance = 0;
    for (let i = 0; i < state.length; i++) totalDistance += Math.abs(accepted[i] - state[i]);
    if (totalDistance / state.length > this.cutThreshold) {
      state.set(accepted);
      return;
    }
    let dt = now - (this.lastEmit ?? this.targetSetTime ?? now);
    if (dt < 0) dt = 0;
    const attack = 1 - Math.exp(-dt / this.attackMs);
    const release = 1 - Math.exp(-dt / this.releaseMs);
    for (let i = 0; i < state.length; i++) {
      const y = state[i];
      const x = accepted[i];
      const diff = x - y;
      if (diff === 0) continue;
      if (diff < absFloor && diff > -absFloor) {
        state[i] = x;
        continue;
      }
      state[i] = y + diff * (diff > 0 ? attack : release);
    }
  }
};
function validateCount(count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`smooth: count must be a positive integer, got ${count}`);
  return count;
}
function requirePositive(name, value) {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`smooth: ${name} must be a positive finite number, got ${value}`);
}
function requireNonNegative(name, value) {
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`smooth: ${name} must be a non-negative finite number, got ${value}`);
}

// lib/engine/stats.ts
function createValueMeter(capacity = 256) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`stats: capacity must be a positive integer, got ${capacity}`);
  const values = new Float64Array(capacity);
  const scratch = new Float64Array(capacity);
  let head = 0;
  let size = 0;
  return {
    add(value) {
      values[head] = value;
      head = (head + 1) % capacity;
      if (size < capacity) size++;
    },
    snapshot() {
      if (size === 0) return { p50: 0, p99: 0, max: 0, samples: 0 };
      const sorted = scratch.subarray(0, size);
      sorted.set(values.subarray(0, size));
      sorted.sort();
      const at = (q) => sorted[Math.min(size - 1, Math.floor(q * size))];
      return { p50: at(0.5), p99: at(0.99), max: sorted[size - 1], samples: size };
    },
    reset() {
      head = 0;
      size = 0;
    }
  };
}
function createArrivalMeter(options = {}) {
  const windowMs = options.windowMs ?? 2e3;
  const gapMs = options.gapMs ?? 50;
  const capacity = options.capacity ?? 1024;
  if (!(windowMs > 0) || !(gapMs > 0) || !Number.isInteger(capacity) || capacity < 2) {
    throw new RangeError(`stats: windowMs and gapMs must be positive and capacity an integer >= 2, got ${windowMs}/${gapMs}/${capacity}`);
  }
  const times = new Float64Array(capacity);
  const scratch = new Float64Array(capacity);
  let head = 0;
  let size = 0;
  let total = 0;
  let gaps = 0;
  let last = null;
  return {
    mark(now) {
      if (last !== null && now - last > gapMs) gaps++;
      last = now;
      total++;
      times[head] = now;
      head = (head + 1) % capacity;
      if (size < capacity) size++;
    },
    snapshot(now) {
      const from = now - windowMs;
      let n = 0;
      let newest = -Infinity;
      let oldest = Infinity;
      let previous = null;
      for (let k = 0; k < size; k++) {
        const t = times[(head - 1 - k + capacity) % capacity];
        if (t < from) break;
        if (previous !== null) scratch[n - 1] = previous - t;
        if (k === 0) newest = t;
        oldest = t;
        previous = t;
        n++;
      }
      if (n < 2) return { fps: 0, p50: 0, p99: 0, max: 0, samples: n, gaps, total };
      const intervals = scratch.subarray(0, n - 1);
      intervals.sort();
      const at = (q) => intervals[Math.min(n - 2, Math.floor(q * (n - 1)))];
      return {
        fps: (n - 1) / (newest - oldest) * 1e3,
        p50: at(0.5),
        p99: at(0.99),
        max: intervals[n - 2],
        samples: n,
        gaps,
        total
      };
    },
    reset() {
      head = 0;
      size = 0;
      total = 0;
      gaps = 0;
      last = null;
    }
  };
}

// lib/engine/runtime.ts
var OUTPUT_HZ = 120;
var TICK_MS = 4;
var REPORT_MS = 1e3;
var RECONNECT_MS = 3e3;
var BAUD_RATE = 921600;
function createEngine(host) {
  const clock2 = host.clock;
  const detector = createBorderDetector({}, clock2);
  const arrivals = createArrivalMeter({ windowMs: 2e3, gapMs: 50 });
  const outputs = createArrivalMeter({ windowMs: 2e3, gapMs: 50 });
  const processTimes = createValueMeter(512);
  const downscaleTimes = createValueMeter(512);
  const readbackTimes = createValueMeter(512);
  const decodeTimes = createValueMeter(512);
  const sampleTimes = createValueMeter(512);
  let captured = 0;
  let pipelineDrops = 0;
  let border2 = NO_BORDER;
  let captureLost = false;
  let state = "idle";
  let lastError;
  let source = null;
  let sourceKind;
  let processing = null;
  let tickTimer = null;
  let reportTimer = null;
  let patternTimer = null;
  let reconnectTimer = null;
  let pattern = null;
  let effect = null;
  let effectSpec = null;
  let effectTimer = null;
  function build(config) {
    const layout = resolveLayout(config);
    const leds = layout.length;
    const { gridWidth, gridHeight } = config.capture;
    const canvas = host.createCanvas(gridWidth, gridHeight);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("engine: this host gave no 2d context");
    return {
      config,
      leds,
      gridWidth,
      gridHeight,
      decoder: createRgbaDecoder(gridWidth, gridHeight),
      grid: allocLinearGrid(gridWidth, gridHeight),
      canvas,
      ctx,
      sampler: createSampler({ layout, width: gridWidth, height: gridHeight }),
      adjustment: createAdjustment([{ leds: "*" }], leds),
      order: createColorOrder(leds, {
        order: config.colorOrder.order,
        ...config.colorOrder.overrides === void 0 ? {} : { overrides: config.colorOrder.overrides }
      }),
      smoother: createSmoother({ mode: "asymmetric", count: leds, outputHz: OUTPUT_HZ }, clock2),
      target: allocLedColors(leds),
      // Built with the stages rather than with the effect: it depends on the
      // layout, and a layout edit while an effect is running must not leave the
      // effect drawing on the old geometry.
      geometry: effectGeometry(layout),
      encoder: createFrameEncoder(
        // WLED never sees one of our wire formats; it gets JSON from its own
        // sink. The encoder still exists so the loopback has something to parse.
        config.output.transport === "wled" ? "Afx" : config.output.format,
        leds,
        config.output.format === "Awa" ? config.output.calibration : void 0
      )
    };
  }
  let stages = build(DEFAULT_ENGINE_CONFIG);
  let linkMode = "none";
  let loopback = createLoopbackSink({ encoder: stages.encoder });
  let sink = loopback;
  let writer = createFrameWriter(loopback);
  let port = null;
  let portWriter = null;
  let portLabel;
  function useLoopback() {
    loopback = createLoopbackSink({ encoder: stages.encoder });
    sink = loopback;
    writer = createFrameWriter(loopback);
    linkMode = "loopback";
    portLabel = void 0;
  }
  function useSink(next, mode, label) {
    const previous = sink;
    sink = next;
    linkMode = mode;
    portLabel = label;
    writer = createFrameWriter(next, { onError: (error) => {
      void onLinkError(error);
    } });
    if (previous !== next && previous !== loopback) void previous.close().catch(() => {
    });
  }
  async function onLinkError(error) {
    lastError = `${linkMode}: ${describe2(error)}`;
    if (linkMode === "port") await dropPort(error);
  }
  async function closePort() {
    const w = portWriter;
    const p = port;
    portWriter = null;
    port = null;
    try {
      await w?.close();
    } catch {
    }
    try {
      w?.releaseLock();
    } catch {
    }
    try {
      await p?.close();
    } catch {
    }
  }
  async function connectLink() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const output = stages.config.output;
    if (output.transport !== "serial") {
      await closePort();
      const address = output.host;
      if (address === void 0 || address.trim() === "") {
        lastError = "a\u011F \xE7\u0131k\u0131\u015F\u0131 i\xE7in adres girilmedi";
        useLoopback();
        return;
      }
      try {
        useSink(
          output.transport === "wled" ? createWledSink({ url: wledUrl(address), leds: stages.leds, segment: output.segment ?? 0 }) : createSocketSink({ url: afxUrl(address), encoder: stages.encoder }),
          output.transport,
          address
        );
      } catch (error) {
        lastError = `${output.transport}: ${describe2(error)}`;
        useLoopback();
      }
      return;
    }
    await connectSerial();
  }
  async function connectSerial() {
    if (port !== null) return;
    const serial = globalThis.navigator?.serial;
    if (serial === void 0) {
      if (linkMode !== "loopback") useLoopback();
      return;
    }
    const ports = await serial.getPorts();
    const next = ports[0];
    if (next === void 0) {
      if (linkMode !== "loopback") useLoopback();
      return;
    }
    try {
      await next.open({ baudRate: BAUD_RATE });
      const w = next.writable?.getWriter();
      if (w === void 0) throw new Error("port has no writable stream");
      port = next;
      portWriter = w;
      const info = next.getInfo();
      const label = `${(info.usbVendorId ?? 0).toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
      useSink(
        createBytesSink({
          kind: "serial",
          label,
          encoder: stages.encoder,
          transport: { write: (bytes) => w.write(bytes) }
        }),
        "port",
        label
      );
      next.addEventListener("disconnect", () => {
        void dropPort(new Error("port disconnected"));
      }, { once: true });
    } catch (error) {
      lastError = `seri port: ${describe2(error)}`;
      if (linkMode !== "loopback") useLoopback();
      scheduleReconnect();
    }
  }
  async function dropPort(error) {
    lastError = `seri port: ${describe2(error)}`;
    await closePort();
    useLoopback();
    scheduleReconnect();
  }
  function scheduleReconnect() {
    if (reconnectTimer !== null || state !== "running") return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectLink();
    }, RECONNECT_MS);
  }
  function rebuildLink() {
    const handle = portWriter;
    if (stages.config.output.transport === "serial" && handle !== null) {
      useSink(
        createBytesSink({
          kind: "serial",
          label: portLabel ?? "serial",
          encoder: stages.encoder,
          transport: { write: (bytes) => handle.write(bytes) }
        }),
        "port",
        portLabel
      );
      return;
    }
    loopback = createLoopbackSink({ encoder: stages.encoder });
    void closePort().then(connectLink).catch(() => {
      useLoopback();
    });
  }
  async function sendControl(request) {
    const send = sink.sendBytes;
    if (send === void 0) throw new Error(`${linkMode}: bu ba\u011Flant\u0131n\u0131n kontrol kanal\u0131 yok`);
    const frame = request.kind === "wifi" ? wifiControl({ ssid: request.ssid, passphrase: request.passphrase, enabled: request.enabled }) : queryControl();
    await send(frame);
  }
  async function processFrame(frame, arrivedAt) {
    let bitmap = null;
    const s = stages;
    try {
      const t0 = clock2();
      const crop = s.config.capture.crop;
      const sx = Math.round(frame.width * crop.left);
      const sy = Math.round(frame.height * crop.top);
      const sw = Math.max(1, Math.round(frame.width * (1 - crop.left - crop.right)));
      const sh = Math.max(1, Math.round(frame.height * (1 - crop.top - crop.bottom)));
      const options = { resizeWidth: s.gridWidth, resizeHeight: s.gridHeight, resizeQuality: "high" };
      const image = frame.image;
      bitmap = sx === 0 && sy === 0 && sw === frame.width && sh === frame.height ? await createImageBitmap(image, options) : await createImageBitmap(image, sx, sy, sw, sh, options);
      frame.release();
      const t1 = clock2();
      s.ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      bitmap = null;
      const rgba = s.ctx.getImageData(0, 0, s.gridWidth, s.gridHeight);
      const t2 = clock2();
      s.decoder.decode(rgba.data, s.grid);
      const t3 = clock2();
      border2 = detector.process(s.grid, t3);
      s.sampler.setBorder(border2);
      s.sampler.sample(s.grid, s.target, "mean");
      s.adjustment.apply(s.target);
      s.smoother.setTarget(s.target, t3);
      const t4 = clock2();
      downscaleTimes.add(t1 - t0);
      readbackTimes.add(t2 - t1);
      decodeTimes.add(t3 - t2);
      sampleTimes.add(t4 - t3);
      processTimes.add(clock2() - arrivedAt);
      tick();
    } finally {
      bitmap?.close();
      frame.release();
    }
  }
  function onFrame(frame, at) {
    arrivals.mark(at);
    captured++;
    if (processing !== null) {
      pipelineDrops++;
      frame.release();
      return;
    }
    processing = processFrame(frame, at).catch((error) => {
      lastError = describe2(error);
    }).finally(() => {
      processing = null;
    });
  }
  function tick() {
    if (state !== "running") return;
    const s = stages;
    const now = clock2();
    const out = s.smoother.tick(now);
    if (out === null) return;
    outputs.mark(now);
    s.order.apply(out);
    writer.send(out);
  }
  function emitEffect() {
    const e = effect;
    if (e === null || state !== "running") return;
    const s = stages;
    e.render(s.target, clock2());
    s.smoother.setTarget(s.target, clock2());
    tick();
  }
  function emitPattern() {
    const p = pattern;
    if (p === null || state !== "running") return;
    const s = stages;
    const now = clock2();
    p.render(s.target, now);
    outputs.mark(now);
    writer.send(s.target);
  }
  function resetCounters() {
    arrivals.reset();
    outputs.reset();
    processTimes.reset();
    downscaleTimes.reset();
    readbackTimes.reset();
    decodeTimes.reset();
    sampleTimes.reset();
    captured = 0;
    pipelineDrops = 0;
    border2 = NO_BORDER;
    detector.reset();
    stages.smoother.reset();
  }
  async function begin(open) {
    if (state === "running" || state === "starting") stop("restart");
    state = "starting";
    lastError = void 0;
    captureLost = false;
    report();
    try {
      const next = await open();
      source = next;
      sourceKind = next.kind;
      resetCounters();
      state = "running";
      tickTimer = setInterval(tick, TICK_MS);
      reportTimer = setInterval(report, REPORT_MS);
      void connectLink();
      next.start(onFrame, (error) => {
        if (error !== void 0) lastError = describe2(error);
        if (state === "running") stop("lost");
      });
      report();
    } catch (error) {
      state = "error";
      lastError = describe2(error);
      report();
    }
  }
  function stop(reason = "user") {
    if (reason === "lost") captureLost = true;
    if (tickTimer !== null) clearInterval(tickTimer);
    if (reportTimer !== null) clearInterval(reportTimer);
    if (patternTimer !== null) clearInterval(patternTimer);
    if (effectTimer !== null) clearInterval(effectTimer);
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    tickTimer = null;
    reportTimer = null;
    patternTimer = null;
    effectTimer = null;
    reconnectTimer = null;
    pattern = null;
    effect = null;
    effectSpec = null;
    const s = source;
    source = null;
    void s?.stop().catch(() => {
    });
    if (state !== "error") state = "idle";
    if (linkMode !== "none" && linkMode !== "loopback") {
      writer.send(stages.target.fill(0));
    }
    report();
  }
  function snapshot() {
    const a = arrivals.snapshot(clock2());
    const o = outputs.snapshot(clock2());
    const p = processTimes.snapshot();
    const w = writer.stats();
    const l = loopback.loopback();
    return {
      state,
      leds: stages.leds,
      capturedFrames: captured,
      deliveredFps: a.fps,
      interArrivalMs: { p50: a.p50, p99: a.p99, max: a.max },
      captureGaps: a.gaps,
      pipelineDrops,
      processMs: { p50: p.p50, p99: p.p99, max: p.max },
      stageMs: {
        downscale: downscaleTimes.snapshot().p50,
        readback: readbackTimes.snapshot().p50,
        decode: decodeTimes.snapshot().p50,
        sample: sampleTimes.snapshot().p50
      },
      outputFps: o.fps,
      link: {
        mode: linkMode,
        written: w.written,
        dropped: w.dropped,
        errors: w.errors,
        // Loopback-only counters. They keep their last values on a real link
        // rather than resetting, because a user who switches from the loopback
        // to a device should still be able to read what the loopback proved.
        accepted: l.accepted,
        rejected: l.rejected,
        ...portLabel !== void 0 ? { port: portLabel } : {},
        detail: sink.stats()
      },
      border: { unknown: border2.unknown, topBottom: border2.topBottom, leftRight: border2.leftRight },
      ...sourceSize(),
      ...sourceKind !== void 0 ? { sourceKind } : {},
      ...pattern !== null ? { pattern: pattern.kind } : {},
      ...effect !== null ? { effect: effect.kind } : {},
      ...captureLost ? { lost: true } : {},
      ...lastError !== void 0 ? { error: lastError } : {}
    };
  }
  function sourceSize() {
    const settings = source?.settings();
    if (settings?.width === void 0 || settings.height === void 0) return {};
    return {
      source: {
        width: settings.width,
        height: settings.height,
        ...settings.frameRate !== void 0 ? { frameRate: settings.frameRate } : {}
      }
    };
  }
  function report() {
    host.onReport?.(snapshot(), state);
  }
  return {
    state: () => state,
    stats: snapshot,
    config: () => stages.config,
    error: () => lastError,
    link: () => ({ mode: linkMode, ...portLabel !== void 0 ? { label: portLabel } : {} }),
    applyConfig(value) {
      const config = parseEngineConfig(value);
      const next = build(config);
      next.sampler.setBorder(border2);
      const outputChanged = JSON.stringify(stages.config.output) !== JSON.stringify(config.output);
      const ledsChanged = stages.leds !== next.leds;
      stages = next;
      if (outputChanged || ledsChanged) rebuildLink();
      if (effectSpec !== null) effect = createEffect(parseEffectSpec(effectSpec), next.geometry, clock2);
      return config;
    },
    async start() {
      await begin(async () => await host.openSource(stages.config));
    },
    async selfTest() {
      const open = host.openSelfTest;
      if (open === void 0) {
        state = "error";
        lastError = "bu ortamda kendi kendine test yok";
        report();
        return;
      }
      await begin(async () => await open(stages.config));
    },
    /**
     * Starts an effect.
     *
     * Deliberately NOT `begin()`: there is no capture, no source and no pump.
     * The effect renders into the same target the sampler would fill, on its
     * own timer, and everything downstream is unchanged.
     */
    runEffect(spec) {
      const parsed = parseEffectSpec(spec);
      if (state === "running" || state === "starting") stop("restart");
      lastError = void 0;
      captureLost = false;
      sourceKind = void 0;
      effectSpec = parsed;
      effect = createEffect(parsed, stages.geometry, clock2);
      state = "running";
      void connectLink();
      effectTimer = setInterval(emitEffect, Math.round(1e3 / OUTPUT_HZ));
      tickTimer = setInterval(tick, TICK_MS);
      reportTimer = setInterval(report, REPORT_MS);
      emitEffect();
      report();
    },
    runPattern(spec) {
      const parsed = parsePatternSpec(spec);
      if (state === "running" || state === "starting") stop("restart");
      lastError = void 0;
      captureLost = false;
      sourceKind = void 0;
      pattern = createPattern(parsed, stages.leds, clock2);
      state = "running";
      void connectLink();
      patternTimer = setInterval(emitPattern, Math.round(1e3 / OUTPUT_HZ));
      reportTimer = setInterval(report, REPORT_MS);
      emitPattern();
      report();
    },
    stop,
    async relink() {
      await closePort();
      await connectLink();
    },
    sendControl
  };
}
function describe2(error) {
  if (!(error instanceof Error)) return String(error);
  return error.name === "" || error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
}

// lib/engine/source.ts
function defaultProcessor(track) {
  const ctor = globalThis.MediaStreamTrackProcessor;
  if (ctor === void 0) throw new Error("source: this browser has no MediaStreamTrackProcessor");
  return new ctor({ track, maxBufferSize: 1 });
}
function createStreamSource(options) {
  const { track, clock: clock2 } = options;
  const makeProcessor = options.processor ?? defaultProcessor;
  let reader = null;
  let stopped = false;
  return {
    kind: "stream",
    settings: () => track.getSettings?.() ?? {},
    start(onFrame, onEnd) {
      let r;
      try {
        r = makeProcessor(track).readable.getReader();
      } catch (error) {
        onEnd?.(error);
        return;
      }
      reader = r;
      void (async () => {
        try {
          for (; ; ) {
            const { value, done } = await r.read();
            if (done || value === void 0) break;
            onFrame({
              image: value,
              width: value.displayWidth,
              height: value.displayHeight,
              release: () => {
                value.close();
              }
            }, clock2());
          }
          if (!stopped) onEnd?.();
        } catch (error) {
          if (!stopped) onEnd?.(error);
        } finally {
          if (reader === r) reader = null;
          try {
            r.releaseLock();
          } catch {
          }
        }
      })();
    },
    async stop() {
      stopped = true;
      const r = reader;
      reader = null;
      try {
        await r?.cancel();
      } catch {
      }
      track.stop();
    }
  };
}

// lib/extension/messages.ts
function isMessage(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string" && value.type.startsWith("ambiflux/");
}

// extension/src/offscreen.ts
var clock = () => performance.now();
var selfTestTimer = null;
async function openSource(config) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      // A ceiling, not a demand: the pipeline is latest-wins, so a source faster
      // than the engine costs drops rather than correctness.
      video: { frameRate: { max: config.capture.fps } }
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "NotAllowedError" ? "Ekran se\xE7ilmedi." : describe3(error));
  }
  const track = stream.getVideoTracks()[0];
  if (track === void 0) throw new Error("yakalama video izi vermedi");
  return createStreamSource({ track, clock });
}
async function openSelfTest() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const paint = canvas.getContext("2d");
  if (paint === null) throw new Error("2d context yok");
  let frame = 0;
  if (selfTestTimer !== null) clearInterval(selfTestTimer);
  selfTestTimer = setInterval(() => {
    const t = frame++ / 120;
    const grad = paint.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, `hsl(${t * 120 % 360} 90% 50%)`);
    grad.addColorStop(1, `hsl(${(t * 120 + 180) % 360} 90% 50%)`);
    paint.fillStyle = grad;
    paint.fillRect(0, 0, canvas.width, canvas.height);
    paint.fillStyle = "#000";
    paint.fillRect(canvas.width * 0.2, canvas.height * 0.2, canvas.width * 0.6, canvas.height * 0.6);
  }, Math.round(1e3 / 60));
  const track = canvas.captureStream(120).getVideoTracks()[0];
  if (track === void 0) throw new Error("captureStream video vermedi");
  return createStreamSource({ track, clock });
}
var engine = createEngine({
  clock,
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  openSource,
  openSelfTest,
  onReport: (stats, state) => {
    void chrome.runtime.sendMessage({ type: "ambiflux/stats", target: "sw", stats }).catch(() => {
    });
    void chrome.runtime.sendMessage({ type: "ambiflux/state", target: "sw", state }).catch(() => {
    });
  }
});
function stopEngine() {
  if (selfTestTimer !== null) {
    clearInterval(selfTestTimer);
    selfTestTimer = null;
  }
  engine.stop();
}
function describe3(error) {
  if (!(error instanceof Error)) return String(error);
  return error.name === "" || error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isMessage(message) || !("target" in message) || message.target !== "offscreen") return false;
  switch (message.type) {
    case "ambiflux/start":
      engine.start().then(() => sendResponse({ state: engine.state(), error: engine.error() }));
      return true;
    case "ambiflux/selftest":
      engine.selfTest().then(() => sendResponse({ state: engine.state(), error: engine.error() }));
      return true;
    case "ambiflux/pattern":
      try {
        engine.runPattern(message.spec);
        sendResponse({ state: engine.state(), pattern: engine.stats().pattern });
      } catch (error) {
        sendResponse({ state: engine.state(), error: describe3(error) });
      }
      return false;
    case "ambiflux/effect":
      try {
        engine.runEffect(message.spec);
        sendResponse({ state: engine.state(), effect: engine.stats().effect });
      } catch (error) {
        sendResponse({ state: engine.state(), error: describe3(error) });
      }
      return false;
    case "ambiflux/stop":
      stopEngine();
      sendResponse({ state: engine.state() });
      return false;
    case "ambiflux/serial": {
      const link = engine.link();
      engine.relink().then(() => sendResponse({
        link: engine.link().mode,
        port: engine.link().label ?? link.label,
        error: engine.error()
      }));
      return true;
    }
    case "ambiflux/config":
      try {
        engine.applyConfig(message.config);
        sendResponse({ type: "ambiflux/config-reply", config: engine.config() });
      } catch (error) {
        sendResponse({
          type: "ambiflux/config-reply",
          config: engine.config(),
          error: describe3(error)
        });
      }
      return false;
    case "ambiflux/control":
      engine.sendControl(message.control).then(
        () => sendResponse({ type: "ambiflux/control-reply", sent: true }),
        (error) => sendResponse({
          type: "ambiflux/control-reply",
          sent: false,
          error: describe3(error)
        })
      );
      return true;
    case "ambiflux/config-get":
      sendResponse({ type: "ambiflux/config-reply", config: engine.config() });
      return false;
    case "ambiflux/ping":
      sendResponse({ type: "ambiflux/pong", version: "offscreen", engine: engine.state() });
      return false;
    default:
      return false;
  }
});
void chrome.runtime.sendMessage({ type: "ambiflux/config-get", target: "sw" }).then((reply) => {
  if (typeof reply === "object" && reply !== null && reply.type === "ambiflux/config-reply") {
    const config = reply.config;
    if (config !== null && config !== void 0) engine.applyConfig(config);
  }
}).catch(() => {
});
//# sourceMappingURL=offscreen.js.map
