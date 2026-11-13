// Minimal argument parser. Flags in BOOLEAN never take a value; every other
// `--flag` takes the next argument (or `--flag=value`). `--` ends flag parsing.
// Short flags: -f (file), -h (help).

export const BOOLEAN = new Set([
  "resident", "follow", "pretty", "help", "no-replace", "no-speak", "no-wait",
  "yes", "peek", "off", "headed", "desktop", "all",
]);

const SHORT = { f: "file", h: "help", p: "pretty" };

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (BOOLEAN.has(name)) {
        flags[name] = value === undefined ? true : !/^(0|false|no)$/i.test(value);
      } else {
        if (value === undefined) {
          if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`);
          value = argv[++i];
        }
        flags[name] = value;
      }
      continue;
    }
    if (/^-[a-zA-Z]$/.test(a)) {
      const name = SHORT[a[1]];
      if (!name) throw new Error(`unknown flag ${a}`);
      if (BOOLEAN.has(name)) flags[name] = true;
      else {
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        flags[name] = argv[++i];
      }
      continue;
    }
    pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), flags };
}

// "a.b.c" | ["a","b"] -> ["a","b","c"]
export function toPath(p) {
  if (Array.isArray(p)) return p.map(String);
  if (p === undefined || p === null || p === "") return [];
  return String(p).split(".").filter((s) => s.length > 0);
}

// Parse a CLI value as JSON, falling back to a plain string for convenience
// (`state set title Hello` sets the string "Hello").
export function parseJsonArg(s) {
  try { return JSON.parse(s); } catch { return s; }
}

export function intFlag(v, name, dflt) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}
