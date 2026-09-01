import { createHttpHost, type HostApi } from "@scriv/host-api";

/**
 * The one place in the browser that names a host.
 *
 * The layering rule in docs/ARCHITECTURE.md forbids anything above the seam from fetching an
 * absolute URL of its own choosing; `createHttpHost` therefore takes the base URL as a
 * parameter and this module — the app's composition root, not a package — supplies it. When
 * v2 swaps in the Tauri implementation, this file is the only one that changes.
 */
export const HOST_URL: string =
  (import.meta.env.VITE_SCRIV_HOST as string | undefined) ?? "http://127.0.0.1:4300";

export const host: HostApi = createHttpHost(HOST_URL);

/** Root-relative display path. Falls back to the absolute path when it is outside the root. */
export function relativeTo(root: string, path: string): string {
  if (!root || !path) return path;
  if (path === root) return "";
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
