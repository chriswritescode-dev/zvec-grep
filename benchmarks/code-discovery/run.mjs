import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreFileRetrieval } from "../zg-retrieval/metrics/files.mjs";

export const DEFAULT_MODEL = "local/potion-code-16m-v2";
export const DEFAULT_MODEL_CACHE = join(homedir(), ".zvec-grep", "models");
export const DEFAULT_OUT_ROOT = ".cache/code-discovery";
export const CORPUS_MANIFEST_FILE = ".manifest.json";
export const MODES = Object.freeze(["vector", "hybrid", "fts"]);
export const DEVICES = Object.freeze([
  "auto",
  "cpu",
  "metal",
  "vulkan",
  "cuda",
]);
export const DEFAULT_DEVICE = "cpu";
export const RESULTS_SCHEMA = "code-discovery-eval/1";
export const CORPUS_SCHEMA = "code-discovery-corpus/1";
export const CASES_SCHEMA = "code-discovery-cases/1";
export const EXTERNAL_SOURCE_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".vue",
  ".svelte",
  ".sql",
  ".tf",
]);
export const EXTERNAL_EXCLUDED_SEGMENTS = Object.freeze([
  "tests",
  "test",
  "__tests__",
  "__mocks__",
  "fixtures",
  "__fixtures__",
  "e2e",
  "docs",
  "doc",
  "benchmarks",
  "benchmark",
  "eval",
  "evals",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
]);
export const EXTERNAL_EXCLUDED_NAMES = Object.freeze(["conftest.py"]);
export const EXTERNAL_EXCLUDED_PATTERNS = Object.freeze([
  "*.test.*",
  "*.spec.*",
  "test_*.py",
  "*_test.py",
  "*.d.ts",
]);

const DIST_ENTRY = "dist/index.js";
const WARMUP_QUERY = "warmup";
const RESULT_LIMIT = 10;
const FORBIDDEN_CORPUS_SEGMENT =
  /(^|\/)(test|tests|docs|doc|eval|evals|benchmark|benchmarks)(\/|$)/i;
const EXTERNAL_SEGMENTS = new Set(EXTERNAL_EXCLUDED_SEGMENTS);
const EXTERNAL_NAMES = new Set(EXTERNAL_EXCLUDED_NAMES);

export function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/");
}

function byPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function isCanonicalCorpusPath(value) {
  const path = normalizeRelativePath(value);
  if (path.length === 0) {
    return false;
  }
  if (path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) {
    return false;
  }
  return path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function assertCorpusPaths(relativePaths) {
  for (const relativePath of relativePaths) {
    assert.ok(
      isCanonicalCorpusPath(relativePath),
      `corpus path must be canonical: ${relativePath}`,
    );
  }
}

function assertContained(rootDir, targetPath) {
  const offset = relative(resolve(rootDir), resolve(targetPath));
  assert.ok(
    offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset),
    `path escapes corpus root: ${targetPath}`,
  );
}

export function isExternalSourcePath(relativePath) {
  const path = normalizeRelativePath(relativePath);
  if (!isCanonicalCorpusPath(path)) {
    return false;
  }
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  const directories = segments.slice(0, -1);
  if (directories.some((segment) => EXTERNAL_SEGMENTS.has(segment))) {
    return false;
  }
  if (EXTERNAL_NAMES.has(name)) {
    return false;
  }
  if (name.endsWith(".d.ts")) {
    return false;
  }
  if (/\.(test|spec)\.[^.]+$/.test(name)) {
    return false;
  }
  if (/^test_.*\.py$/.test(name) || /_test\.py$/.test(name)) {
    return false;
  }
  return EXTERNAL_SOURCE_EXTENSIONS.some((extension) =>
    name.endsWith(extension),
  );
}

export function selectExternalSourcePaths(trackedPaths) {
  return trackedPaths
    .filter((relativePath) => isExternalSourcePath(relativePath))
    .map((relativePath) => normalizeRelativePath(relativePath))
    .sort();
}

export function externalSelectionPolicy() {
  return {
    kind: "git-tracked-source",
    extensions: [...EXTERNAL_SOURCE_EXTENSIONS],
    excludeSegments: [...EXTERNAL_EXCLUDED_SEGMENTS],
    excludeNames: [...EXTERNAL_EXCLUDED_NAMES],
    excludePatterns: [...EXTERNAL_EXCLUDED_PATTERNS],
  };
}

export function digestFileHashes(entries) {
  const sorted = entries
    .map((entry) => ({
      path: normalizeRelativePath(entry.path),
      sha256: entry.sha256,
    }))
    .sort(byPath);
  const hash = createHash("sha256");
  for (const entry of sorted) {
    hash.update(`${entry.path}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

export async function hashFile(path) {
  const data = await readFile(path);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
  };
}

export async function hashTree(rootDir, relativePaths) {
  const entries = [];
  for (const relativePath of relativePaths) {
    const { sha256, bytes } = await hashFile(join(rootDir, relativePath));
    entries.push({
      path: normalizeRelativePath(relativePath),
      sha256,
      bytes,
    });
  }
  return entries.sort(byPath);
}

export async function listFiles(rootDir, extension) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(normalizeRelativePath(relative(rootDir, absolute)));
      }
    }
  }
  await walk(rootDir);
  return files.sort();
}

export function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    out: undefined,
    corpus: undefined,
    root: undefined,
    cases: undefined,
    modelCache: DEFAULT_MODEL_CACHE,
    device: DEFAULT_DEVICE,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const take = () => {
      if (inline !== undefined) {
        if (inline.length === 0) {
          throw new Error(`${name} requires a value`);
        }
        return inline;
      }
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      return next;
    };
    if (name === "--model") {
      options.model = take();
    } else if (name === "--out") {
      options.out = take();
    } else if (name === "--corpus") {
      options.corpus = take();
    } else if (name === "--root") {
      options.root = take();
    } else if (name === "--cases") {
      options.cases = take();
    } else if (name === "--model-cache") {
      options.modelCache = take();
    } else if (name === "--device") {
      options.device = take();
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.model.trim().length === 0) {
    throw new Error("--model must not be empty");
  }
  if (options.modelCache.trim().length === 0) {
    throw new Error("--model-cache must not be empty");
  }
  if (!DEVICES.includes(options.device)) {
    throw new Error(`--device must be one of ${DEVICES.join(", ")}`);
  }
  if (options.root !== undefined && options.root.trim().length === 0) {
    throw new Error("--root must not be empty");
  }
  if (options.cases !== undefined && options.cases.trim().length === 0) {
    throw new Error("--cases must not be empty");
  }
  return options;
}

export function resolveModelCache(value) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function toRetrievalItems(items) {
  return items.map((item) => ({
    rank: item.rank,
    path: item.file.relativePath,
    range: {
      kind: item.range.kind,
      start_line: item.range.startLine,
      end_line: item.range.endLine,
    },
  }));
}

export function toFileTargets(paths) {
  return paths.map((path) => ({ path }));
}

export function scoreRanking(items, targets) {
  return scoreFileRetrieval(toRetrievalItems(items), targets);
}

export function aggregateScores(scores) {
  const mean = (key) =>
    scores.length
      ? scores.reduce((sum, score) => sum + score[key], 0) / scores.length
      : null;
  return {
    scored: scores.length,
    hit_at_1: mean("hit_at_1"),
    hit_at_5: mean("hit_at_5"),
    hit_at_10: mean("hit_at_10"),
    mrr_at_10: mean("rr_at_10"),
  };
}

export function assertCorpusIsolation(relativePaths) {
  for (const relativePath of relativePaths) {
    const normalized = normalizeRelativePath(relativePath);
    assert.ok(
      !FORBIDDEN_CORPUS_SEGMENT.test(normalized),
      `corpus must not include ${normalized}`,
    );
    assert.ok(
      normalized.startsWith("src/"),
      `corpus path must live under src/: ${normalized}`,
    );
    assert.ok(
      isCanonicalCorpusPath(normalized),
      `corpus path must be canonical: ${normalized}`,
    );
    assert.ok(
      normalized.endsWith(".ts"),
      `corpus path must be TypeScript: ${normalized}`,
    );
  }
}

export async function assertTargetsExist(corpusRoot, targets) {
  for (const target of targets) {
    await access(join(corpusRoot, normalizeRelativePath(target)));
  }
}

export function validateSuite(suite, corpusPaths) {
  assert.equal(suite?.schema, CASES_SCHEMA);
  assert.ok(Array.isArray(suite.cases), "cases must be an array");
  assert.ok(suite.cases.length > 0, "suite must define at least one case");
  const available = new Set(
    [...corpusPaths].map((path) => normalizeRelativePath(path)),
  );
  const ids = new Set();
  for (const testCase of suite.cases) {
    assert.equal(typeof testCase.id, "string");
    assert.ok(testCase.id.length > 0, "case id must not be empty");
    assert.ok(!ids.has(testCase.id), `duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    assert.equal(typeof testCase.query, "string");
    assert.ok(testCase.query.trim().length > 0, "case query must not be empty");
    assert.ok(
      Array.isArray(testCase.targets) && testCase.targets.length > 0,
      `case ${testCase.id} requires targets`,
    );
    assert.equal(
      new Set(testCase.targets).size,
      testCase.targets.length,
      `case ${testCase.id} requires unique targets`,
    );
    for (const target of testCase.targets) {
      assert.equal(typeof target, "string");
      const path = normalizeRelativePath(target);
      assert.ok(
        isCanonicalCorpusPath(path),
        `target must be canonical: ${target}`,
      );
      assert.ok(
        available.has(path),
        `target must be present in the frozen corpus: ${target}`,
      );
    }
  }
}

function defaultOutDirectory() {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return resolve(DEFAULT_OUT_ROOT, stamp);
}

function describeError(scope, error) {
  return {
    scope,
    message: error instanceof Error ? error.message : String(error),
    code:
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : null,
  };
}

function formatScore(value) {
  return value === null || value === undefined ? "n/a" : value.toFixed(3);
}

async function saveResults(path, results) {
  await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
}

function gitOutput(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  }).trim();
}

function gitRevision(repoRoot) {
  return gitOutput(repoRoot, ["rev-parse", "HEAD"]);
}

export function readTrackedFiles(repoRoot) {
  const output = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--full-name"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return output.split("\0").filter((entry) => entry.length > 0);
}

async function readStableFile(sourcePath, label) {
  const before = await lstat(sourcePath);
  const bytes = await readFile(sourcePath);
  const after = await lstat(sourcePath);
  assert.ok(
    before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      bytes.byteLength === before.size,
    `source changed while freezing: ${label}`,
  );
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function listLegacyCorpusPaths(repoRoot) {
  const sourceRoot = join(repoRoot, "src");
  const relativePaths = await listFiles(sourceRoot, ".ts");
  return relativePaths
    .map((relativePath) => normalizeRelativePath(join("src", relativePath)))
    .sort();
}

async function writeCorpusManifest(corpusRoot, manifest) {
  await writeFile(
    join(corpusRoot, CORPUS_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return (await hashFile(join(corpusRoot, CORPUS_MANIFEST_FILE))).sha256;
}

async function freezeCorpus(repoRoot, corpusRoot) {
  const commit = gitRevision(repoRoot);
  const corpusPaths = await listLegacyCorpusPaths(repoRoot);
  assertCorpusIsolation(corpusPaths);
  const entries = [];
  for (const corpusPath of corpusPaths) {
    const destination = join(corpusRoot, corpusPath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repoRoot, corpusPath), destination);
    const { sha256, bytes } = await hashFile(destination);
    entries.push({ path: corpusPath, sha256, bytes });
  }
  entries.sort(byPath);
  const manifest = {
    schema: CORPUS_SCHEMA,
    source: { kind: "frozen", root: repoRoot, commit },
    files: entries,
    corpusSha256: digestFileHashes(entries),
  };
  const manifestSha256 = await writeCorpusManifest(corpusRoot, manifest);
  return { source: manifest.source, entries, manifestSha256 };
}

export async function freezeExternalCorpus(repoRoot, corpusRoot) {
  const toplevel = gitOutput(repoRoot, ["rev-parse", "--show-toplevel"]);
  const [rootReal, toplevelReal] = await Promise.all([
    realpath(repoRoot),
    realpath(toplevel),
  ]);
  assert.equal(
    rootReal,
    toplevelReal,
    "external root must be a git repository root",
  );
  const commit = gitRevision(repoRoot);
  const trackedPaths = readTrackedFiles(repoRoot);
  assertCorpusPaths(trackedPaths);
  const relativePaths = selectExternalSourcePaths(trackedPaths);
  assert.ok(
    relativePaths.length > 0,
    "external repository has no tracked production source files",
  );
  const entries = [];
  for (const relativePath of relativePaths) {
    const sourcePath = join(repoRoot, relativePath);
    assertContained(repoRoot, sourcePath);
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      continue;
    }
    const { bytes, sha256 } = await readStableFile(sourcePath, relativePath);
    const destination = join(corpusRoot, relativePath);
    assertContained(corpusRoot, destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    const copied = await hashFile(destination);
    assert.equal(
      copied.sha256,
      sha256,
      `corpus file changed while freezing: ${relativePath}`,
    );
    entries.push({ path: relativePath, sha256, bytes: bytes.byteLength });
  }
  entries.sort(byPath);
  const manifest = {
    schema: CORPUS_SCHEMA,
    source: {
      kind: "external",
      root: repoRoot,
      commit,
      policy: externalSelectionPolicy(),
    },
    files: entries,
    corpusSha256: digestFileHashes(entries),
  };
  const manifestSha256 = await writeCorpusManifest(corpusRoot, manifest);
  return { source: manifest.source, entries, manifestSha256 };
}

function manifestPolicyKind(manifest) {
  const source = manifest?.source;
  if (source?.kind === "external") {
    return "external";
  }
  if (source?.kind === "copied") {
    return manifestPolicyKind({ source: source.upstream });
  }
  return "frozen";
}

function assertManifestPolicy(manifest, paths) {
  if (manifestPolicyKind(manifest) === "external") {
    for (const path of paths) {
      assert.ok(
        isExternalSourcePath(path),
        `corpus path violates the external selection policy: ${path}`,
      );
    }
    return;
  }
  assertCorpusIsolation(paths);
}

export async function copyCorpus(sourceCorpus, corpusRoot) {
  const sourceManifestPath = join(sourceCorpus, CORPUS_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  assert.equal(manifest?.schema, CORPUS_SCHEMA);
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "corpus manifest requires files",
  );
  const paths = manifest.files.map((file) => normalizeRelativePath(file.path));
  assertCorpusPaths(paths);
  assert.equal(new Set(paths).size, paths.length, "duplicate corpus paths");
  assertManifestPolicy(manifest, paths);
  const expected = new Map(
    manifest.files.map((file) => [
      normalizeRelativePath(file.path),
      file.sha256,
    ]),
  );
  for (const path of paths) {
    const sourcePath = join(sourceCorpus, path);
    assertContained(sourceCorpus, sourcePath);
    const stats = await lstat(sourcePath);
    assert.ok(
      stats.isFile() && !stats.isSymbolicLink(),
      `corpus entry must be a regular file: ${path}`,
    );
    const { sha256 } = await hashFile(sourcePath);
    assert.equal(sha256, expected.get(path), `corpus file changed: ${path}`);
    const destination = join(corpusRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination);
  }
  await cp(sourceManifestPath, join(corpusRoot, CORPUS_MANIFEST_FILE));
  const entries = await hashTree(corpusRoot, paths);
  for (const entry of entries) {
    assert.equal(
      entry.sha256,
      expected.get(entry.path),
      `corpus file changed: ${entry.path}`,
    );
  }
  assert.equal(
    digestFileHashes(entries),
    manifest.corpusSha256,
    "corpus digest does not match the preserved manifest",
  );
  const manifestSha256 = (
    await hashFile(join(corpusRoot, CORPUS_MANIFEST_FILE))
  ).sha256;
  return {
    source: {
      kind: "copied",
      path: sourceCorpus,
      upstream: manifest.source ?? null,
    },
    entries,
    manifestSha256,
  };
}

function corpusCommitOf(source) {
  if (!source) {
    return null;
  }
  if (typeof source.commit === "string") {
    return source.commit;
  }
  if (source.upstream) {
    return corpusCommitOf(source.upstream);
  }
  return null;
}

function contextOptions(mode, query) {
  if (mode === "vector") {
    return {
      routes: [{ mode: "vector", query }],
      limit: RESULT_LIMIT,
      autoUpdate: false,
      preferSymbol: false,
    };
  }
  if (mode === "fts") {
    return {
      routes: [{ mode: "fts", query }],
      limit: RESULT_LIMIT,
      autoUpdate: false,
      preferSymbol: false,
    };
  }
  return {
    query,
    limit: RESULT_LIMIT,
    autoUpdate: false,
    preferSymbol: false,
  };
}

function printHelp() {
  console.log(
    [
      "Usage: node benchmarks/code-discovery/run.mjs [options]",
      "",
      "Options:",
      `  --model <reference>   Embedding model (default ${DEFAULT_MODEL})`,
      "  --out <directory>     Output directory (default .cache/code-discovery/<timestamp>)",
      "  --root <directory>    External git repository to freeze (default current codebase)",
      "  --cases <file>        Case suite JSON (default benchmarks/code-discovery/cases.json)",
      "  --corpus <directory>  Copy a previous run's frozen corpus instead of freezing source",
      `  --model-cache <dir>   Model cache directory (default ${DEFAULT_MODEL_CACHE})`,
      `  --device <device>     Requested runtime device, recorded in results; not a guarantee that the hardware was used (default ${DEFAULT_DEVICE}; one of ${DEVICES.join(", ")})`,
      "  --help                Print this message",
    ].join("\n"),
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const implementationRoot = resolve(here, "..", "..");
  const external = options.root !== undefined;
  const sourceRoot = external ? resolve(options.root) : implementationRoot;
  const casesPath = options.cases
    ? resolve(options.cases)
    : join(here, "cases.json");
  const outDir = options.out ? resolve(options.out) : defaultOutDirectory();
  const corpusRoot = join(outDir, "corpus");
  const homeDir = join(outDir, "home");
  const indexDir = join(outDir, "indexes");
  const resultsPath = join(outDir, "results.json");
  assert.notEqual(corpusRoot, sourceRoot);
  const failures = [];
  let service;
  let results = null;
  try {
    await mkdir(dirname(outDir), { recursive: true });
    await mkdir(outDir);
    await mkdir(homeDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });
    const casesBytes = await readFile(casesPath);
    const casesSha256 = createHash("sha256").update(casesBytes).digest("hex");
    const suite = JSON.parse(casesBytes.toString("utf8"));
    const corpus = options.corpus
      ? await copyCorpus(resolve(options.corpus), corpusRoot)
      : external
        ? await freezeExternalCorpus(sourceRoot, corpusRoot)
        : await freezeCorpus(sourceRoot, corpusRoot);
    validateSuite(
      suite,
      corpus.entries.map((entry) => entry.path),
    );
    const distRoot = join(implementationRoot, "dist");
    const distEntries = await hashTree(
      distRoot,
      await listFiles(distRoot, ".js"),
    );
    const distEntrySha256 = (
      await hashFile(join(implementationRoot, DIST_ENTRY))
    ).sha256;
    const implementationRevision = gitRevision(implementationRoot);
    results = {
      schema: RESULTS_SCHEMA,
      createdAt: new Date().toISOString(),
      git: {
        revision: implementationRevision,
        corpusRevision: corpusCommitOf(corpus.source),
      },
      source: {
        repoRoot: sourceRoot,
        implementationRoot,
        corpusRoot,
        corpus: corpus.source,
        corpusSha256: digestFileHashes(corpus.entries),
        corpusManifestSha256: corpus.manifestSha256,
        casesPath,
        casesSha256,
        distEntrySha256,
        distJsSha256: digestFileHashes(distEntries),
      },
      model: {
        reference: options.model,
        device: options.device,
        embeddingConcurrency: 1,
        modelCacheDir: resolveModelCache(options.modelCache),
        info: null,
      },
      index: null,
      modes: {},
      failures,
      ok: false,
    };
    await saveResults(resultsPath, results);
    process.env.ZVEC_GREP_HOME = homeDir;
    process.env.ZVEC_GREP_INDEX_HOME = indexDir;
    process.env.ZVEC_GREP_MODEL_CACHE = results.model.modelCacheDir;
    const { createZvecGrep } = await import(
      pathToFileURL(join(implementationRoot, DIST_ENTRY)).href
    );
    service = await createZvecGrep({
      root: corpusRoot,
      embedding: options.model,
      modelCacheDir: results.model.modelCacheDir,
      device: options.device,
      embeddingConcurrency: 1,
    });
    console.error(
      `[code-discovery] indexing ${corpus.entries.length} files under ${corpusRoot}`,
    );
    const indexStarted = performance.now();
    const indexResult = await service.index({
      root: corpusRoot,
      embeddingConcurrency: 1,
    });
    const indexDurationMs = performance.now() - indexStarted;
    console.error(
      `[code-discovery] indexed ${indexResult.filesScanned} files in ${Math.round(indexDurationMs)}ms`,
    );
    results.index = { durationMs: indexDurationMs, result: indexResult };
    const info = await service.info({ includeStatus: true });
    const embedding = info.workspaceIndex?.embedding ?? null;
    results.model.info = embedding;
    results.index.status = info.status
      ? {
          filesPending: info.status.filesPending,
          filesFailed: info.status.filesFailed,
          filesIndexed: info.status.filesIndexed,
        }
      : null;
    const [provider, ...rest] = options.model.split("/");
    const expectedModel = rest.join("/");
    if (
      !info.indexed ||
      !embedding ||
      embedding.provider !== provider ||
      embedding.model !== expectedModel
    ) {
      failures.push({
        scope: "embedding",
        message: `expected ${options.model}, got ${JSON.stringify(embedding)}`,
        code: null,
      });
    }
    const indexFailed = info.status?.filesFailed ?? 0;
    const indexPending = info.status?.filesPending ?? 0;
    if (indexFailed > 0 || indexPending > 0) {
      failures.push({
        scope: "index",
        message: `indexing incomplete: ${indexFailed} failed, ${indexPending} pending`,
        code: null,
      });
    }
    await saveResults(resultsPath, results);
    if (indexFailed === 0 && indexPending === 0) {
      for (const mode of MODES) {
        await service
          .context(contextOptions(mode, WARMUP_QUERY))
          .catch(() => undefined);
      }
      for (const mode of MODES) {
        const modeResult = { aggregate: null, queries: [] };
        results.modes[mode] = modeResult;
        for (const testCase of suite.cases) {
          const started = performance.now();
          let response;
          let status = "ok";
          let error = null;
          let ranking = [];
          let metrics;
          try {
            response = await service.context(
              contextOptions(mode, testCase.query),
            );
          } catch (failure) {
            status = "error";
            error = describeError(`${mode}:${testCase.id}`, failure);
            failures.push(error);
          }
          const latencyMs = performance.now() - started;
          if (response) {
            const items =
              response.groupResults?.[0]?.items ?? response.items ?? [];
            ranking = items.map((item) => ({
              rank: item.rank,
              path: item.file.relativePath,
              score: item.score ?? null,
              matchedBy: item.matchedBy,
              range: item.range,
            }));
            metrics = scoreRanking(items, toFileTargets(testCase.targets));
          } else {
            metrics = scoreRanking([], toFileTargets(testCase.targets));
          }
          modeResult.queries.push({
            id: testCase.id,
            query: testCase.query,
            targets: testCase.targets,
            status,
            error,
            latencyMs,
            metrics,
            ranking,
          });
          await saveResults(resultsPath, results);
        }
        modeResult.aggregate = aggregateScores(
          modeResult.queries.map((query) => query.metrics),
        );
        console.error(
          `[code-discovery] ${mode}: hit@1=${formatScore(modeResult.aggregate.hit_at_1)} hit@5=${formatScore(modeResult.aggregate.hit_at_5)} hit@10=${formatScore(modeResult.aggregate.hit_at_10)} mrr@10=${formatScore(modeResult.aggregate.mrr_at_10)} (n=${modeResult.aggregate.scored})`,
        );
        await saveResults(resultsPath, results);
      }
    }
  } catch (error) {
    failures.push(describeError("run", error));
    if (!results) {
      console.error(error instanceof Error ? error.stack : String(error));
    }
  } finally {
    if (service) {
      try {
        await service.close();
      } catch (error) {
        failures.push(describeError("close", error));
      }
    }
  }
  if (results) {
    results.failures = failures;
    results.ok = failures.length === 0;
    await saveResults(resultsPath, results).catch(() => undefined);
  }
  return failures.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
