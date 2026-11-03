// Copies shared/lib into each example's lib folder, so every example stays a standalone folder you can copy out of
// the repo. Edit a file in shared/lib, never a copy, then run `node scripts/sync-shared.mjs`.
//
// tenderly.ts and log.ts go to every example. Any other shared file goes only to the examples that already have it.
// `--check` changes nothing and exits 1 when a copy is missing or differs; CI runs it on every pull request.
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = join(ROOT, "shared/lib");
const EVERY_EXAMPLE = new Set(["tenderly.ts", "log.ts"]);
const check = process.argv.includes("--check");

const examples = readdirSync(join(ROOT, "examples"), { withFileTypes: true })
  .filter((group) => group.isDirectory())
  .flatMap((group) => readdirSync(join(ROOT, "examples", group.name), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "examples", group.name, d.name, "package.json")))
    .map((d) => join(ROOT, "examples", group.name, d.name)))
  .sort();

const problems = [];
let copied = 0;
for (const file of readdirSync(SHARED).sort()) {
  const source = readFileSync(join(SHARED, file));
  for (const example of examples) {
    const target = join(example, "lib", file);
    const exists = existsSync(target);
    if (!exists && !EVERY_EXAMPLE.has(file)) continue;
    if (exists && readFileSync(target).equals(source)) continue;
    if (check) {
      problems.push(`${relative(ROOT, target)} ${exists ? "differs from" : "is missing, copy"} shared/lib/${file}`);
    } else {
      copyFileSync(join(SHARED, file), target);
      copied++;
    }
  }
}

if (check && problems.length) {
  console.error(problems.join("\n"));
  console.error("\nEdit shared/lib, then run: node scripts/sync-shared.mjs");
  process.exit(1);
}
console.log(check ? `shared/lib is in sync with ${examples.length} examples` : `copied ${copied} files`);
