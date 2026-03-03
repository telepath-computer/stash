export function isTrackedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("../")) {
    return false;
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return false;
    }
    if (segment === ".stash") {
      return false;
    }
    if (segment.startsWith(".")) {
      return false;
    }
  }

  return true;
}
