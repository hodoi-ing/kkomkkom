import { relative, sep } from "node:path";

/** ENOENT is an absent optional path; every other read error means evidence is missing. */
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Root-relative path for reports. It never contains file contents. */
export function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}
