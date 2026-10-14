import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every member carries a JSDoc, so hovering it in an editor is never blank.
 *
 * A member documents itself twice, for two readers that cannot share one copy. The `description` string
 * is runtime data: it reaches a caller through the property schema and the generated `ActionSpec`, so a
 * host can offer the feature without a branch per capability. The JSDoc above the member is what an
 * EDITOR shows — `Surface` is homomorphic precisely so the comment survives onto `dev.lock().lock()`,
 * and a comment is the only thing hover can read. Neither can be derived from the other: a string never
 * becomes a doc comment, and a comment is gone at runtime.
 *
 * Only PRESENCE is enforced. The two are not required to match, because the better ones already differ
 * on purpose: the description says what the value IS, to a caller rendering a control, while the JSDoc
 * says why the wire looks the way it does, to whoever edits it next. Requiring one text would delete
 * that second half everywhere it already exists.
 *
 * @module model/capabilities/__tests__/member-docs
 */

const DIR = join(import.meta.dirname, "..");

/** One member's two documented copies, as they appear in the source text. */
interface DocumentedMember {
  label: string;
  jsdoc: string | undefined;
  description: string;
}

/** Strip a JSDoc block's leading ` * ` gutter, leaving the prose. */
function prose(block: string): string {
  return block
    .replace(/^\s*\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^[ \t]*\*[ \t]?/gm, "")
    .trim();
}

/** Join a `"a" + "b"` description literal into the string the compiler would produce. */
function literal(source: string): string {
  return [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).join("");
}

/**
 * Every member declared in a module's `members` table, with the JSDoc block immediately above it.
 *
 * Read from the SOURCE text rather than the imported module, because a comment does not survive into a
 * value — reading the file is the only way to see the half of the pair that hover uses. Members are
 * found by indentation: a table entry opens at exactly two spaces, so the scan never descends into the
 * nested objects a member's own fields declare.
 */
function membersOf(file: string): DocumentedMember[] {
  const source = readFileSync(join(DIR, file), "utf8");
  const table = /_MEMBERS = \{\n(.*?)\n\} as const satisfies Members/s.exec(source);
  if (!table) return [];
  const lines = table[1].split("\n");
  const starts: { key: string; line: number }[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /^ {2}(\w+): [{m]/.exec(line);
    if (m) starts.push({ key: m[1], line: i });
  }
  return starts.map(({ key, line }, i) => {
    const chunk = lines.slice(line, starts[i + 1]?.line ?? lines.length).join("\n");
    const above = lines.slice(0, line).join("\n");
    const jsdoc = /\/\*\*(?:.|\n)*?\*\/\s*$/.exec(above);
    const desc = /^ {4}description:((?:.|\n)*?),\n(?= {2,4}\S)/m.exec(chunk);
    return {
      label: `${file.replace(".ts", "")}.${key}`,
      jsdoc: jsdoc ? prose(jsdoc[0]) : undefined,
      description: desc ? literal(desc[1]) : literal(/"[^"]*"/.exec(chunk)?.[0] ?? ""),
    };
  });
}

const members = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "members.ts" && f !== "types.ts")
  .flatMap(membersOf)
  .filter((m) => m.description.length > 0);

describe("every member is documented for an editor, not only for a caller", () => {
  it("finds the member tables at all — a silent zero would pass every case below", () => {
    expect(members.length).toBeGreaterThan(120);
  });

  it.each(members)("$label carries a JSDoc, so hover is not blank", ({ jsdoc }) => {
    expect(jsdoc?.length ?? 0).toBeGreaterThan(0);
  });
});
