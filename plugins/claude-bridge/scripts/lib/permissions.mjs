import fs from "node:fs";
import path from "node:path";

export function validatePermissionMode(mode) {
  if (mode != null && !["acceptEdits", "bypassPermissions"].includes(mode)) {
    throw new Error("permissionMode must be acceptEdits or bypassPermissions.");
  }
  return mode ?? null;
}

// Explicit requests and operator defaults may elevate delegation; repository config cannot.
export function executionPermissions({ kind, paths, requestedMode, source = "request" }) {
  if (kind !== "delegate") return { mode: "default", source: "read-only", trustedDirectory: null };
  const explicit = validatePermissionMode(requestedMode);
  if (explicit) return { mode: explicit, source, trustedDirectory: null };
  const fallback = { mode: "acceptEdits", source: "built-in", trustedDirectory: null };
  if (!paths.globalConfigPath || !fs.existsSync(paths.globalConfigPath)) return fallback;
  const host = JSON.parse(fs.readFileSync(paths.globalConfigPath, "utf8"));
  const trusted = host.runtime?.trustedDelegateDirectories ?? [];
  if (!Array.isArray(trusted) || trusted.some((p) => typeof p !== "string" || !path.isAbsolute(p))) {
    throw new Error("runtime.trustedDelegateDirectories must contain absolute directory paths in host config.");
  }
  const root = fs.realpathSync(paths.repoRoot);
  for (const directory of trusted) {
    let canonical;
    try { canonical = fs.realpathSync(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (canonical === root) return { mode: "bypassPermissions", source: "host-trusted-directory", trustedDirectory: root };
  }
  return fallback;
}
