import { readFile, writeFile } from "node:fs/promises";

const next = process.argv[2];
if (!next || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(next)) {
  throw new Error("Usage: pnpm version:set 0.4.1 (stable major.minor.patch)");
}
const packagePath = new URL("../package.json", import.meta.url);
const androidPath = new URL("../android/app/build.gradle", import.meta.url);
const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const before = pkg.version.split(".").map(Number);
const after = next.split(".").map(Number);
const changed = after.findIndex((part, index) => part !== before[index]);
if (changed < 0 || after[changed] < before[changed]) throw new Error("New version must increase.");
const gradle = await readFile(androidPath, "utf8");
const match = gradle.match(/\bversionCode (\d+)/);
if (!match) throw new Error("Android versionCode is missing.");
const code = Number(match[1]) + 1;
if (code > 2_100_000_000) throw new Error("Android versionCode limit exceeded.");
// Read and validate both inputs before changing either version source.
await writeFile(androidPath, gradle.replace(/\bversionCode \d+/, `versionCode ${code}`));
pkg.version = next;
await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Version ${next}; Android versionCode ${code}. Rebuild both platforms together.`);
