import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CASES_SCHEMA,
  CORPUS_MANIFEST_FILE,
  DEFAULT_DEVICE,
  DEFAULT_MODEL,
  DEVICES,
  aggregateScores,
  assertCorpusIsolation,
  assertCorpusPaths,
  assertTargetsExist,
  copyCorpus,
  digestFileHashes,
  freezeExternalCorpus,
  hashFile,
  hashTree,
  isExternalSourcePath,
  listFiles,
  listLegacyCorpusPaths,
  normalizeRelativePath,
  parseArgs,
  resolveModelCache,
  scoreRanking,
  selectExternalSourcePaths,
  toFileTargets,
  toRetrievalItems,
  validateSuite,
} from "./run.mjs";

function git(directory, args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

async function createRepository(directory) {
  await mkdir(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "bench@example.com"]);
  git(directory, ["config", "user.name", "Bench"]);
  return directory;
}

async function writeAt(root, relativePath, content) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function readManifest(corpusRoot) {
  return JSON.parse(
    await readFile(join(corpusRoot, CORPUS_MANIFEST_FILE), "utf8"),
  );
}

test("parseArgs applies defaults and validates every flag", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.model, DEFAULT_MODEL);
  assert.equal(defaults.out, undefined);
  assert.equal(defaults.corpus, undefined);
  assert.equal(defaults.root, undefined);
  assert.equal(defaults.cases, undefined);
  assert.ok(defaults.modelCache.endsWith(join(".zvec-grep", "models")));
  assert.equal(defaults.device, "cpu");
  assert.equal(defaults.help, false);
  assert.equal(parseArgs(["--model", "local/other"]).model, "local/other");
  assert.equal(parseArgs(["--out=abc"]).out, "abc");
  assert.equal(parseArgs(["--corpus", "prev"]).corpus, "prev");
  assert.equal(parseArgs(["--root", "/repo"]).root, "/repo");
  assert.equal(parseArgs(["--cases=suite.json"]).cases, "suite.json");
  assert.equal(parseArgs(["--model-cache", "/m"]).modelCache, "/m");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--model"]), /requires a value/);
  assert.throws(() => parseArgs(["--model", "--out", "x"]), /requires a value/);
  assert.throws(() => parseArgs(["--out="]), /requires a value/);
  assert.throws(() => parseArgs(["--root="]), /requires a value/);
  assert.throws(() => parseArgs(["--cases", ""]), /must not be empty/);
  assert.equal(resolveModelCache("~/models"), join(homedir(), "models"));
});

test("parseArgs defaults to cpu and accepts every supported device", () => {
  assert.equal(DEFAULT_DEVICE, "cpu");
  assert.deepEqual([...DEVICES], ["auto", "cpu", "metal", "vulkan", "cuda"]);
  assert.equal(parseArgs([]).device, DEFAULT_DEVICE);
  for (const device of DEVICES) {
    assert.equal(parseArgs(["--device", device]).device, device);
    assert.equal(parseArgs([`--device=${device}`]).device, device);
  }
  assert.equal(parseArgs(["--device", "metal"]).device, "metal");
});

test("parseArgs rejects a missing or unsupported device", () => {
  assert.throws(() => parseArgs(["--device"]), /requires a value/);
  assert.throws(
    () => parseArgs(["--device", "--out", "x"]),
    /requires a value/,
  );
  assert.throws(() => parseArgs(["--device="]), /requires a value/);
  assert.throws(
    () => parseArgs(["--device", "tpu"]),
    /--device must be one of auto, cpu, metal, vulkan, cuda/,
  );
  assert.throws(() => parseArgs(["--device", ""]), /--device must be one of/);
});

test("hashTree and digestFileHashes are content and order stable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-discovery-hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "a.ts"), "export const a = 1;\n");
  await writeFile(join(sourceRoot, "b.ts"), "export const b = 2;\n");
  const paths = await listFiles(sourceRoot, ".ts");
  assert.deepEqual(paths, ["a.ts", "b.ts"]);
  const entries = await hashTree(sourceRoot, paths);
  const digest = digestFileHashes(entries);
  assert.equal(digest, digestFileHashes([...entries].reverse()));
  assert.equal(
    entries[0].sha256,
    (await hashFile(join(sourceRoot, "a.ts"))).sha256,
  );
  await writeFile(join(sourceRoot, "b.ts"), "export const b = 3;\n");
  const changed = digestFileHashes(await hashTree(sourceRoot, paths));
  assert.notEqual(changed, digest);
  assert.equal(
    normalizeRelativePath("src\\engine\\index.ts"),
    "src/engine/index.ts",
  );
});

test("scoreRanking keeps native ranks without deduplicating repeated chunks", () => {
  const items = [
    {
      rank: 1,
      file: { relativePath: "src/a.ts" },
      range: { kind: "text", startLine: 1, endLine: 2 },
    },
    {
      rank: 2,
      file: { relativePath: "src/a.ts" },
      range: { kind: "text", startLine: 3, endLine: 4 },
    },
    {
      rank: 3,
      file: { relativePath: "src/b.ts" },
      range: { kind: "text", startLine: 1, endLine: 2 },
    },
  ];
  assert.deepEqual(
    toRetrievalItems(items).map((item) => item.rank),
    [1, 2, 3],
  );
  const first = scoreRanking(items, [{ path: "src/a.ts" }]);
  assert.equal(first.hit_at_1, 1);
  assert.equal(first.rr_at_10, 1);
  assert.deepEqual(first.target_ranks, [1]);
  assert.deepEqual(
    scoreRanking(items, toFileTargets(["src/a.ts"])).target_ranks,
    [1],
  );
  const late = scoreRanking(items, [{ path: "src/b.ts" }]);
  assert.equal(late.first_hit_rank, 3);
  assert.equal(late.hit_at_5, 1);
  assert.ok(Math.abs(late.rr_at_10 - 1 / 3) < 1e-12);
  const missed = scoreRanking([], [{ path: "src/a.ts" }]);
  assert.equal(missed.hit_at_10, 0);
  assert.equal(missed.rr_at_10, 0);
  assert.equal(missed.first_hit_rank, "not_in_top10");
  const aggregate = aggregateScores([first, late, missed]);
  assert.equal(aggregate.scored, 3);
  assert.ok(Math.abs(aggregate.hit_at_1 - 1 / 3) < 1e-12);
  assert.ok(Math.abs(aggregate.hit_at_5 - 2 / 3) < 1e-12);
  assert.ok(Math.abs(aggregate.mrr_at_10 - 1 / 3 - 1 / 9) < 1e-12);
});

test("corpus isolation rejects forbidden paths and targets resolve", async (t) => {
  assert.throws(() => assertCorpusIsolation(["test/a.ts"]), /must not include/);
  assert.throws(
    () => assertCorpusIsolation(["src/docs/a.ts"]),
    /must not include/,
  );
  assert.throws(
    () => assertCorpusIsolation(["src/benchmarks/a.ts"]),
    /must not include/,
  );
  assert.throws(() => assertCorpusIsolation(["src/a.js"]), /TypeScript/);
  assert.throws(() => assertCorpusIsolation(["lib/a.ts"]), /under src/);
  assert.throws(
    () => assertCorpusIsolation(["src/../outside.ts"]),
    /canonical/,
  );
  assertCorpusIsolation(["src/engine/service/index.ts"]);
  const directory = await mkdtemp(join(tmpdir(), "code-discovery-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/engine.ts"), "export {};\n");
  await assertTargetsExist(directory, ["src/engine.ts"]);
  await assert.rejects(() => assertTargetsExist(directory, ["src/missing.ts"]));
});

test("corpus path validation rejects traversal and absolute paths", () => {
  assertCorpusPaths(["src/a.ts", "app/main.py"]);
  assert.throws(() => assertCorpusPaths(["../evil.ts"]), /canonical/);
  assert.throws(() => assertCorpusPaths(["/abs/evil.ts"]), /canonical/);
  assert.throws(() => assertCorpusPaths(["src/./a.ts"]), /canonical/);
  assert.throws(() => assertCorpusPaths([""]), /canonical/);
});

test("external selection keeps tracked production sources only", () => {
  const tracked = [
    "app/main.py",
    "web/Component.tsx",
    "src/keep.ts",
    "pkg/util.go",
    "db/schema.sql",
    "infra/main.tf",
    "tests/foo_test.py",
    "test/helper.py",
    "src/foo.test.ts",
    "web/Component.spec.tsx",
    "src/foo.d.ts",
    "docs/guide.ts",
    "benchmarks/case.ts",
    "eval/questions.ts",
    "node_modules/pkg/index.js",
    "dist/bundle.js",
    "coverage/report.ts",
    "__tests__/a.ts",
    "__mocks__/b.ts",
    "fixtures/c.ts",
    "e2e/d.ts",
    "conftest.py",
    "src/test_helpers.py",
    "src/helpers_test.py",
    "assets/logo.png",
    "package.json",
  ];
  assert.deepEqual(selectExternalSourcePaths(tracked), [
    "app/main.py",
    "db/schema.sql",
    "infra/main.tf",
    "pkg/util.go",
    "src/keep.ts",
    "web/Component.tsx",
  ]);
  assert.equal(isExternalSourcePath("app/main.py"), true);
  assert.equal(isExternalSourcePath("web/Component.tsx"), true);
  assert.equal(isExternalSourcePath("src/foo.test.ts"), false);
  assert.equal(isExternalSourcePath("docs/guide.ts"), false);
  assert.equal(isExternalSourcePath("node_modules/pkg/index.js"), false);
  assert.equal(isExternalSourcePath("src/foo.d.ts"), false);
  assert.equal(isExternalSourcePath("../escape.ts"), false);
  assert.equal(isExternalSourcePath("/abs.ts"), false);
});

test("freezeExternalCorpus copies tracked sources and excludes the rest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-discovery-ext-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await createRepository(join(directory, "repo"));
  await writeAt(repo, "app/main.py", "print('hi')\n");
  await writeAt(repo, "web/Component.tsx", "export const C = 1;\n");
  await writeAt(repo, "src/keep.ts", "export const keep = 1;\n");
  await writeAt(repo, "tests/foo_test.py", "def test_x():\n    pass\n");
  await writeAt(repo, "docs/guide.ts", "export const guide = 1;\n");
  await writeAt(repo, "eval/questions.ts", "export const q = 1;\n");
  await writeAt(repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
  await writeAt(repo, "src/foo.test.ts", "export const t = 1;\n");
  await writeAt(repo, "package.json", "{}\n");
  await writeFile(join(directory, "outside.ts"), "export const o = 1;\n");
  await mkdir(join(repo, "pkg"), { recursive: true });
  await symlink(join(directory, "outside.ts"), join(repo, "pkg/linked.ts"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  await writeAt(repo, ".env", "SECRET=1\n");
  await writeAt(repo, "secrets/api.ts", "export const secret = 1;\n");
  const corpusRoot = join(directory, "corpus");
  const frozen = await freezeExternalCorpus(repo, corpusRoot);
  const manifest = await readManifest(corpusRoot);
  const paths = manifest.files.map((file) => file.path);
  assert.deepEqual(paths, ["app/main.py", "src/keep.ts", "web/Component.tsx"]);
  assert.equal(manifest.source.kind, "external");
  assert.equal(manifest.source.root, repo);
  assert.equal(manifest.source.commit, git(repo, ["rev-parse", "HEAD"]).trim());
  assert.equal(frozen.source.commit, manifest.source.commit);
  assert.equal(frozen.entries.length, 3);
  assert.ok(!paths.includes("pkg/linked.ts"));
  assert.ok(!paths.includes(".env"));
  assert.ok(!paths.includes("secrets/api.ts"));
  assert.ok(!paths.includes("eval/questions.ts"));
  assert.ok(!paths.includes("tests/foo_test.py"));
  for (const entry of manifest.files) {
    assert.equal(typeof entry.bytes, "number");
    assert.equal(
      entry.bytes,
      (await readFile(join(corpusRoot, entry.path))).byteLength,
    );
    assert.equal(
      entry.sha256,
      (await hashFile(join(corpusRoot, entry.path))).sha256,
    );
  }
});

test("copyCorpus preserves external provenance and rejects changed files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-discovery-copy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await createRepository(join(directory, "repo"));
  await writeAt(repo, "app/main.py", "print('hi')\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  const frozenRoot = join(directory, "frozen");
  await freezeExternalCorpus(repo, frozenRoot);
  const copiedRoot = join(directory, "copied");
  const copied = await copyCorpus(frozenRoot, copiedRoot);
  assert.equal(copied.source.kind, "copied");
  assert.equal(copied.source.path, frozenRoot);
  assert.equal(copied.source.upstream.kind, "external");
  assert.equal(copied.source.upstream.root, repo);
  assert.equal(
    copied.source.upstream.commit,
    git(repo, ["rev-parse", "HEAD"]).trim(),
  );
  const copiedManifest = await readManifest(copiedRoot);
  assert.equal(copiedManifest.source.kind, "external");
  assert.equal(copiedManifest.source.commit, copied.source.upstream.commit);
  await writeFile(join(frozenRoot, "app/main.py"), "print('tampered')\n");
  await assert.rejects(
    () => copyCorpus(frozenRoot, join(directory, "copied-again")),
    /corpus file changed/,
  );
});

test("copyCorpus rejects a manifest entry that is a symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "code-discovery-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await createRepository(join(directory, "repo"));
  await writeAt(repo, "src/keep.ts", "export const keep = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  const frozenRoot = join(directory, "frozen");
  await freezeExternalCorpus(repo, frozenRoot);
  const corpusFile = join(frozenRoot, "src/keep.ts");
  await rm(corpusFile);
  await writeFile(join(directory, "outside.ts"), "export const o = 1;\n");
  await symlink(join(directory, "outside.ts"), corpusFile);
  await assert.rejects(
    () => copyCorpus(frozenRoot, join(directory, "copied")),
    /regular file/,
  );
});

test("validateSuite uses the suite length and requires frozen targets", () => {
  const suite = {
    schema: CASES_SCHEMA,
    cases: [{ id: "only", query: "where", targets: ["app/main.py"] }],
  };
  validateSuite(suite, ["app/main.py", "src/keep.ts"]);
  assert.throws(() => validateSuite(suite, ["src/keep.ts"]), /frozen corpus/);
  assert.throws(
    () =>
      validateSuite(
        {
          schema: CASES_SCHEMA,
          cases: [
            { id: "a", query: "q", targets: ["app/main.py"] },
            { id: "a", query: "q", targets: ["app/main.py"] },
          ],
        },
        ["app/main.py"],
      ),
    /duplicate case id/,
  );
  assert.throws(
    () => validateSuite({ schema: CASES_SCHEMA, cases: [] }, []),
    /at least one case/,
  );
  assert.throws(
    () =>
      validateSuite(
        {
          schema: CASES_SCHEMA,
          cases: [{ id: "a", query: "q", targets: ["../escape.ts"] }],
        },
        ["../escape.ts"],
      ),
    /canonical/,
  );
});

test("cases.json defines source-backed targets inside the frozen corpus", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const suite = JSON.parse(await readFile(join(here, "cases.json"), "utf8"));
  const corpusPaths = await listLegacyCorpusPaths(repoRoot);
  validateSuite(suite, corpusPaths);
  assert.equal(suite.cases.length, 20);
});
