/**
 * Random phone-model + user-agent generation for the account's device identity.
 *
 * The cloud stores a `phone_model` per login and the media CDN wants a real Android `user-agent`. A
 * single hardcoded value (every install reporting the same model/UA) is an obvious fingerprint once
 * more than a handful of people run the SDK. These helpers pick a realistic model instead — SEEDED by
 * the install's `openudid` so it is STABLE across runs (a value that changed each run would look like a
 * new device every launch and trigger a fresh-device 2FA every time). Pass no seed for a one-off random
 * value. An explicitly configured `phoneModel` / `mediaUserAgent` pins the identity and never reaches
 * here.
 */

/** Brand → the parts a model string is composed from. `${brand}${first}${second}`. */
const PHONE_MODELS: Record<string, { first: string[]; second: string[] }> = {
  "Pixel ": { first: ["6", "6a", "6 Pro", "7", "7a", "7 Pro", "8", "8a", "8 Pro", "9", "9 Pro"], second: [""] },
  "SM-": {
    first: ["G991B", "G996B", "G998B", "S901B", "S906B", "S908B", "S911B", "S918B", "A525F", "A536B", "A546B", "N986B"],
    second: [""],
  },
  "Redmi Note ": { first: ["10", "11", "12", "13"], second: ["", " Pro", " Pro+", " 5G"] },
  "OnePlus ": { first: ["9", "10", "11", "12"], second: ["", " Pro", "R"] },
  CPH: { first: ["2001", "2005", "2211", "2247", "2451", "2609"], second: [""] },
  V: { first: ["2050", "2109", "2207", "2312"], second: [""] },
  M: { first: ["2101", "2103", "2201", "2210", "2304", "2312"], second: ["K7AG", "K6P", "J20C", "DRG4C"] },
};

const ANDROID_VERSIONS = ["12", "13", "14", "15"];
const BUILD_PREFIXES = ["TP1A", "TQ3A", "UP1A", "UQ1A", "AP1A", "AP2A"];

/** Deterministic FNV-1a hash of a seed string → uint32. */
function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, deterministic from a uint32 seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random source: deterministic when `seed` is given, else `Math.random`. */
function rng(seed?: string): () => number {
  return seed === undefined ? Math.random : mulberry32(hashSeed(seed));
}

/**
 * A realistic random Android phone model (e.g. `SM-G998B`, `Pixel 7 Pro`, `Redmi Note 12 Pro`). With a
 * `seed` the result is stable for that seed — pass the install's `openudid` so it stays put across runs.
 */
export function randomPhoneModel(seed?: string): string {
  const rnd = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const brand = pick(Object.keys(PHONE_MODELS));
  const parts = PHONE_MODELS[brand];
  return `${brand}${pick(parts.first)}${pick(parts.second)}`.trim();
}

/**
 * A realistic Dalvik `user-agent` for the media download path, consistent with `model` (defaults to a
 * fresh {@link randomPhoneModel}). Deterministic for a given `seed`.
 */
export function randomUserAgent(seed?: string, model?: string): string {
  const rnd = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const dev = model ?? randomPhoneModel(seed);
  const build = `${pick(BUILD_PREFIXES)}.${String(220000 + Math.floor(rnd() * 79999)).slice(0, 6)}.${String(
    Math.floor(rnd() * 900) + 100,
  )}`;
  return `Dalvik/2.1.0 (Linux; U; Android ${pick(ANDROID_VERSIONS)}; ${dev} Build/${build})`;
}
