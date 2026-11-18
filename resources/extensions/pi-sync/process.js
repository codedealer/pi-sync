/**
 * Windows PATH executables such as `pi-sync` and `git` may be .cmd shims that
 * Node cannot launch directly. A shell lets Windows resolve them through
 * PATHEXT, while path-qualified executables must run directly (especially when
 * the path contains spaces).
 */
export function shellFor(executable, platform = process.platform) {
  if (platform !== "win32") return false;
  return !/[\\/]/.test(executable) && !/\.[A-Za-z0-9]+$/.test(executable);
}
