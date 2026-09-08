import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readGlobalConfig } from "../config.js";
import { defaultHome } from "../utils/path.js";
import { deleteWorkspaceManifest, workspaceManifestPath } from "../manifest.js";
import {
  deleteWorkspaceIndexStorage,
  hasWorkspaceIndexStorage,
} from "../storage/index.js";
import { workspaceIndexPath } from "../storage/layout.js";

export const ZVEC_GREP_DIR = ".zvec-grep";
export const ZVEC_GREP_INDEX_HOME_ENV = "ZVEC_GREP_INDEX_HOME";
export const INDEX_HOME_PROJECT = "project";
export const WORKSPACES_DIRNAME = "workspaces";
export const WORKSPACE_KEY_LENGTH = 32;
export type WorkspaceIndexLocation = {
  root: string;
  home: string;
  manifestPath: string;
  indexPath: string;
};

export type IndexHomeMode =
  { kind: "project" } | { kind: "central"; centralRoot: string };

export function resolveZvecGrepRoot(root: string | undefined): string {
  return resolve(root ?? process.cwd());
}

export function workspaceHome(root: string): string {
  return join(resolve(root), ZVEC_GREP_DIR);
}

export function workspaceKey(root: string): string {
  return createHash("sha256")
    .update(resolve(root))
    .digest("hex")
    .slice(0, WORKSPACE_KEY_LENGTH);
}

export function defaultWorkspacesHome(): string {
  return join(defaultHome(), WORKSPACES_DIRNAME);
}

export function resolveIndexHomeMode(
  environment: NodeJS.ProcessEnv = process.env,
  config: { defaults?: { indexHome?: string } } = readGlobalConfig(),
): IndexHomeMode {
  const value =
    nonEmptyEnvironmentValue(environment[ZVEC_GREP_INDEX_HOME_ENV]) ??
    config.defaults?.indexHome;
  if (value === undefined) {
    return { kind: "central", centralRoot: defaultWorkspacesHome() };
  }
  if (value === INDEX_HOME_PROJECT) {
    return { kind: "project" };
  }
  return { kind: "central", centralRoot: resolve(value) };
}

export function workspaceIndexLocation(root: string): WorkspaceIndexLocation {
  return workspaceIndexLocationFor(root, resolveIndexHomeMode());
}

export function workspaceIndexLocationFor(
  root: string,
  mode: IndexHomeMode,
): WorkspaceIndexLocation {
  const resolvedRoot = resolve(root);
  if (mode.kind === "project") {
    const requestedHome = workspaceHome(resolvedRoot);
    const home = existsSync(requestedHome)
      ? realpathSync(requestedHome)
      : requestedHome;
    const canonicalRoot = dirname(home);

    return {
      root: canonicalRoot,
      home,
      manifestPath: workspaceManifestPath(home),
      indexPath: workspaceIndexPath(home),
    };
  }

  const canonicalRoot = realpathIfExists(resolvedRoot);
  const home = realpathIfExists(
    join(mode.centralRoot, workspaceKey(canonicalRoot)),
  );
  return {
    root: canonicalRoot,
    home,
    manifestPath: workspaceManifestPath(home),
    indexPath: workspaceIndexPath(home),
  };
}

export function resetWorkspaceIndex(location: WorkspaceIndexLocation): void {
  deleteWorkspaceManifest(location.home);
  deleteWorkspaceIndexStorage(location.home);
}

export function findNearestWorkspaceIndex(
  start: string,
): WorkspaceIndexLocation | null {
  return findNearestWorkspaceLocation(start, hasWorkspaceIndex);
}

export function findNearestWorkspace(
  start: string,
): WorkspaceIndexLocation | null {
  return findNearestWorkspaceLocation(start, hasWorkspaceManifest);
}

function findNearestWorkspaceLocation(
  start: string,
  predicate: (location: WorkspaceIndexLocation) => boolean,
): WorkspaceIndexLocation | null {
  const mode = resolveIndexHomeMode();
  let current = resolve(start);

  while (true) {
    const location = workspaceIndexLocationFor(current, mode);
    if (predicate(location)) {
      return location;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function hasWorkspaceManifest(
  location: WorkspaceIndexLocation,
): boolean {
  return existsSync(location.manifestPath);
}

export function hasWorkspaceIndex(location: WorkspaceIndexLocation): boolean {
  return (
    hasWorkspaceManifest(location) && hasWorkspaceIndexStorage(location.home)
  );
}

function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function nonEmptyEnvironmentValue(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
