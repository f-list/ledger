/**
 * The app may be mounted at a subpath (production: /_ledger/ behind nginx,
 * which strips the prefix before proxying). Derive the mount point from the
 * current URL so API calls and navigation stay within it.
 */
function derive(): string {
  const path = location.pathname;
  if (path.endsWith('/register')) return path.slice(0, -'register'.length);
  return path.endsWith('/') ? path : `${path}/`;
}

/** Absolute pathname of the app root, always with a trailing slash (e.g. "/" or "/_ledger/"). */
export const appBase = derive();

/** Resolve an app-root-relative path ("/api/events" or "register") against the mount point. */
export function appPath(path: string): string {
  return appBase + path.replace(/^\//, '');
}
