/** Prefix files in public/ when the site is built under a project subdirectory. */
export function publicAssetUrl(path: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const prefix = basePath ? '/' + basePath.replace(/^\/+|\/+$/g, '') : '';
  if (!prefix || prefix === '/' || path === prefix || path.startsWith(prefix + '/')) return path;
  return prefix + path;
}
