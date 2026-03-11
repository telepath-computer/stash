import type { FileMutation } from "../types.ts";

export type Direction = "up" | "down" | "both";

export function mutationDirection(mutation: FileMutation): Direction {
  if (mutation.disk === "skip" && (mutation.remote === "write" || mutation.remote === "delete")) {
    return "up";
  }
  if (mutation.remote === "skip" && (mutation.disk === "write" || mutation.disk === "delete")) {
    return "down";
  }
  return "both";
}

export function directionArrow(direction: Direction): string {
  if (direction === "up") {
    return "↑";
  }
  if (direction === "down") {
    return "↓";
  }
  return "↑↓";
}

export function formatSummary(mutations: FileMutation[]): string {
  let up = 0;
  let down = 0;
  let both = 0;

  for (const mutation of mutations) {
    if (mutation.disk === "skip" && mutation.remote === "skip") {
      continue;
    }

    const direction = mutationDirection(mutation);
    if (direction === "up") {
      up += 1;
    } else if (direction === "down") {
      down += 1;
    } else {
      both += 1;
    }
  }

  const parts: string[] = [];
  if (up > 0) {
    parts.push(`${up}↑`);
  }
  if (down > 0) {
    parts.push(`${down}↓`);
  }
  if (both > 0) {
    parts.push(`${both}↑↓`);
  }
  return parts.join(" ");
}

export function formatTimeAgo(date: Date): string {
  const elapsedMs = Date.now() - date.getTime();
  if (elapsedMs < 5_000) {
    return "just now";
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1_000);
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

export function formatCountdown(targetDate: Date): string {
  const remainingMs = targetDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return "0s";
  }

  const remainingSeconds = Math.round(remainingMs / 1_000);
  if (remainingSeconds < 60) {
    return `${remainingSeconds}s`;
  }

  const remainingMinutes = Math.floor(remainingSeconds / 60);
  return `${remainingMinutes}m`;
}
