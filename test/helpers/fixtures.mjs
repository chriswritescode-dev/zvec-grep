import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after } from "node:test";

const execFileAsync = promisify(execFile);

export const cliPath = resolve("dist/cli/index.js");

export async function useTemporaryFileHome() {
  const home = await mkdtemp(join(tmpdir(), "zvec-grep-file-home-"));
  const previous = process.env.ZVEC_GREP_HOME;
  process.env.ZVEC_GREP_HOME = home;
  after(async () => {
    if (previous === undefined) {
      delete process.env.ZVEC_GREP_HOME;
    } else {
      process.env.ZVEC_GREP_HOME = previous;
    }
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });
  return home;
}

export async function createTemporaryDirectory(
  t,
  prefix = "zvec-grep-test-",
  options = {},
) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  if (options.cleanup !== false) {
    t.after(() => removeTemporaryDirectory(directory));
  }
  return directory;
}

export async function removeTemporaryDirectory(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

export async function useTemporaryHome(t) {
  const home = await createTemporaryDirectory(t, "zvec-grep-home-");
  const previous = process.env.ZVEC_GREP_HOME;
  process.env.ZVEC_GREP_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ZVEC_GREP_HOME;
    } else {
      process.env.ZVEC_GREP_HOME = previous;
    }
  });
  return home;
}

export async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, ["--liftoff-only", cliPath, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
  });
}
