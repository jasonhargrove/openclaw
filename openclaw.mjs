#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const entryCandidates = ["dist/entry.js", "dist/entry.mjs"];

const exists = async (relativePath) => {
  try {
    await access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
};

const hasAnyEntryBuild = async () => {
  for (const candidate of entryCandidates) {
    if (await exists(candidate)) {
      return true;
    }
  }
  return false;
};

const hasCommand = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { stdio: "ignore", shell: false });
  return !result.error;
};

const resolvePnpmRunner = () => {
  if (hasCommand("pnpm")) {
    return {
      displayName: "pnpm",
      run: (args) => spawnSync("pnpm", args, { cwd: rootDir, stdio: "inherit", shell: false }),
    };
  }

  if (hasCommand("corepack")) {
    return {
      displayName: "corepack pnpm",
      run: (args) =>
        spawnSync("corepack", ["pnpm", ...args], { cwd: rootDir, stdio: "inherit", shell: false }),
    };
  }

  return null;
};

const runOrThrow = (runner, args, failureHelp) => {
  const result = runner.run(args);
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `openclaw: ${failureHelp}\n` +
        `Try running manually:\n` +
        `  ${runner.displayName} ${args.join(" ")}`,
    );
  }
};

const ensureDistBuild = async () => {
  if (await hasAnyEntryBuild()) {
    return;
  }

  process.stderr.write("openclaw: missing dist build output; bootstrapping...\n");

  const runner = resolvePnpmRunner();
  if (!runner) {
    throw new Error(
      "openclaw: dist build output is missing and no package manager was found.\n" +
        "Install pnpm (https://pnpm.io/installation) or enable Corepack, then run:\n" +
        "  corepack enable\n" +
        "  corepack pnpm install --frozen-lockfile\n" +
        "  corepack pnpm exec tsdown --no-clean",
    );
  }

  if (!(await exists("node_modules"))) {
    runOrThrow(runner, ["install", "--frozen-lockfile"], "dependency installation failed.");
  }

  runOrThrow(runner, ["exec", "tsdown", "--no-clean"], "build failed.");

  if (!(await hasAnyEntryBuild())) {
    throw new Error(
      "openclaw: bootstrap completed but dist/entry.(m)js is still missing.\n" +
        "Try a clean build manually and rerun:\n" +
        `  ${runner.displayName} install --frozen-lockfile\n` +
        `  ${runner.displayName} exec tsdown --no-clean`,
    );
  }
};

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await ensureDistBuild();
await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
      return false;
    }
    throw err;
  }
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("openclaw: missing dist/entry.(m)js (build output).");
}
