#!/usr/bin/env node
// Single source of truth for the Zuum version: the root package.json.
//
//   node scripts/version.mjs print            -> prints the version (used by CI)
//   node scripts/version.mjs check            -> fails if any workspace or deploy compose disagrees, or if not semver
//   node scripts/version.mjs bump <patch|minor|major|prerelease|X.Y.Z[-pre]>
//
// "bump" rewrites the version in every package.json and the default image tag in
// deploy/docker-compose.yml, so the release tag, the Docker image tags and the
// compose file always carry the same semantic version.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Semantic Versioning 2.0.0 (https://semver.org), without a leading "v".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PACKAGES = ["package.json", "packages/db/package.json", "packages/shared/package.json", "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json"];
const COMPOSE = "deploy/docker-compose.yml";
const COMPOSE_RE = /\$\{ZUUM_VERSION:-([^}]+)\}/g;

const read = (p) => readFileSync(join(root, p), "utf8");
const pkgVersion = (p) => JSON.parse(read(p)).version;

function fail(msg) {
  console.error(`version: ${msg}`);
  process.exit(1);
}

function next(current, kind) {
  if (SEMVER.test(kind)) return kind;
  const m = SEMVER.exec(current);
  if (!m) fail(`current version "${current}" is not semver`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4];
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      // 1.2.3-rc.1 -> 1.2.3 (finishing a prerelease), otherwise 1.2.4.
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case "prerelease": {
      if (!pre) return `${major}.${minor}.${patch + 1}-rc.0`;
      const parts = pre.split(".");
      const last = Number(parts.at(-1));
      return Number.isInteger(last) ? `${major}.${minor}.${patch}-${[...parts.slice(0, -1), last + 1].join(".")}` : `${major}.${minor}.${patch}-${pre}.0`;
    }
    default:
      fail(`unknown bump "${kind}". Use patch, minor, major, prerelease, or an explicit X.Y.Z`);
  }
}

const [cmd, arg] = process.argv.slice(2);
const version = pkgVersion("package.json");

if (cmd === "print") {
  if (!SEMVER.test(version)) fail(`"${version}" is not a semantic version`);
  console.log(version);
} else if (cmd === "check") {
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`root version "${version}" is not semver`);
  for (const p of PACKAGES) if (pkgVersion(p) !== version) problems.push(`${p} has ${pkgVersion(p)}, expected ${version}`);
  const composeVersions = [...read(COMPOSE).matchAll(COMPOSE_RE)].map((m) => m[1]);
  if (!composeVersions.length) problems.push(`${COMPOSE} has no \${ZUUM_VERSION:-...} image tag`);
  for (const v of composeVersions) if (v !== version) problems.push(`${COMPOSE} pins ${v}, expected ${version}`);
  if (problems.length) fail(problems.join("\n  "));
  console.log(`version ${version} consistent across ${PACKAGES.length} packages and ${composeVersions.length} images`);
} else if (cmd === "bump") {
  if (!arg) fail("bump needs an argument");
  const to = next(version, arg);
  for (const p of PACKAGES) {
    const json = JSON.parse(read(p));
    json.version = to;
    writeFileSync(join(root, p), JSON.stringify(json, null, 2) + "\n");
  }
  writeFileSync(join(root, COMPOSE), read(COMPOSE).replace(COMPOSE_RE, `\${ZUUM_VERSION:-${to}}`));
  console.log(`${version} -> ${to}`);
} else {
  fail("usage: version.mjs print | check | bump <patch|minor|major|prerelease|X.Y.Z>");
}
