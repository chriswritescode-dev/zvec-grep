import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  INDEX_HOME_PROJECT,
  defaultWorkspacesHome,
  resolveIndexHomeMode,
  workspaceIndexLocation,
  workspaceIndexLocationFor,
  workspaceKey,
} from "../../dist/engine/service/root.js";

test("workspace index locations resolve an existing index symlink", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zvec-grep-root-"));

  try {
    const corpusRoot = join(temporaryRoot, "corpus");
    const indexHome = join(corpusRoot, ".zvec-grep");
    const workspaceRoot = join(temporaryRoot, "workspace");
    await mkdir(indexHome, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await symlink(indexHome, join(workspaceRoot, ".zvec-grep"));

    const canonicalHome = realpathSync(indexHome);
    const canonicalRoot = dirname(canonicalHome);
    assert.deepEqual(
      workspaceIndexLocationFor(workspaceRoot, { kind: "project" }),
      {
        root: canonicalRoot,
        home: canonicalHome,
        manifestPath: join(canonicalHome, "manifest.json"),
        indexPath: join(canonicalHome, "index.zvec"),
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("workspace index locations default to the central workspaces home", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "zvec-grep-home-"));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zvec-grep-root-"));

  try {
    const location = workspaceIndexLocationFor(temporaryRoot, {
      kind: "central",
      centralRoot: temporaryHome,
    });
    assert.equal(location.root, realpathSync(temporaryRoot));
    assert.equal(
      location.home,
      join(temporaryHome, workspaceKey(temporaryRoot)),
    );
    assert.equal(location.manifestPath, join(location.home, "manifest.json"));
    assert.equal(location.indexPath, join(location.home, "index.zvec"));
    assert.equal(existsSync(location.home), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("workspace keys are stable across equivalent paths and unique per root", () => {
  const root = "/tmp/zvec-grep-key-example";
  const key = workspaceKey(root);
  assert.equal(key, workspaceKey(join(root, "nested", "..")));
  assert.equal(key.length, 32);
  assert.notEqual(key, workspaceKey(`${root}-other`));
});

test("index home mode prefers the environment over config and defaults to central", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "zvec-grep-home-"));

  try {
    assert.deepEqual(resolveIndexHomeMode({}, { defaults: undefined }), {
      kind: "central",
      centralRoot: defaultWorkspacesHome(),
    });
    assert.deepEqual(
      resolveIndexHomeMode({ ZVEC_GREP_INDEX_HOME: "project" }),
      { kind: "project" },
    );
    const custom = join(temporaryHome, "custom-indexes");
    assert.deepEqual(resolveIndexHomeMode({ ZVEC_GREP_INDEX_HOME: custom }), {
      kind: "central",
      centralRoot: custom,
    });
    assert.deepEqual(
      resolveIndexHomeMode({}, { defaults: { indexHome: custom } }),
      { kind: "central", centralRoot: custom },
    );
    assert.deepEqual(
      resolveIndexHomeMode(
        { ZVEC_GREP_INDEX_HOME: "project" },
        { defaults: { indexHome: custom } },
      ),
      { kind: "project" },
    );
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("project mode keeps the workspace index under the workspace root", () => {
  const temporaryRoot = "/tmp/zvec-grep-project-mode-missing";
  const location = workspaceIndexLocationFor(temporaryRoot, {
    kind: "project",
  });
  assert.equal(location.root, temporaryRoot);
  assert.equal(location.home, join(temporaryRoot, ".zvec-grep"));
});

test("project mode via environment resolves project layout", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zvec-grep-env-"));
  const previous = process.env.ZVEC_GREP_INDEX_HOME;

  try {
    process.env.ZVEC_GREP_INDEX_HOME = INDEX_HOME_PROJECT;
    const location = workspaceIndexLocation(temporaryRoot);
    assert.equal(location.home, join(temporaryRoot, ".zvec-grep"));
  } finally {
    if (previous === undefined) {
      delete process.env.ZVEC_GREP_INDEX_HOME;
    } else {
      process.env.ZVEC_GREP_INDEX_HOME = previous;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
