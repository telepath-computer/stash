import test from "node:test";
import assert from "node:assert/strict";
import type { FileMutation } from "../../src/types.ts";
import {
  directionArrow,
  formatCountdown,
  formatSummary,
  formatTimeAgo,
  mutationDirection,
} from "../../src/ui/format.ts";

test("format: mutationDirection maps push-to-remote mutations", () => {
  assert.equal(
    mutationDirection({ path: "a.md", disk: "skip", remote: "write" }),
    "up",
  );
  assert.equal(
    mutationDirection({ path: "a.md", disk: "skip", remote: "delete" }),
    "up",
  );
});

test("format: mutationDirection maps pull-from-remote mutations", () => {
  assert.equal(
    mutationDirection({ path: "a.md", disk: "write", remote: "skip" }),
    "down",
  );
  assert.equal(
    mutationDirection({ path: "a.md", disk: "delete", remote: "skip" }),
    "down",
  );
});

test("format: mutationDirection maps merge mutations", () => {
  assert.equal(
    mutationDirection({ path: "a.md", disk: "write", remote: "write" }),
    "both",
  );
});

test("format: directionArrow renders arrows", () => {
  assert.equal(directionArrow("up"), "↑");
  assert.equal(directionArrow("down"), "↓");
  assert.equal(directionArrow("both"), "↑↓");
});

test("format: formatSummary renders mixed direction totals", () => {
  const mutations: FileMutation[] = [
    { path: "a.md", disk: "skip", remote: "write" },
    { path: "b.md", disk: "skip", remote: "write" },
    { path: "c.md", disk: "write", remote: "skip" },
    { path: "d.md", disk: "write", remote: "write" },
  ];
  assert.equal(formatSummary(mutations), "2↑ 1↓ 1↑↓");
});

test("format: formatSummary renders a single direction", () => {
  const mutations: FileMutation[] = [
    { path: "a.md", disk: "skip", remote: "write" },
    { path: "b.md", disk: "skip", remote: "delete" },
    { path: "c.md", disk: "skip", remote: "write" },
  ];
  assert.equal(formatSummary(mutations), "3↑");
});

test("format: formatSummary returns empty string for empty input", () => {
  assert.equal(formatSummary([]), "");
});

test("format: formatSummary omits skip/skip mutations", () => {
  assert.equal(
    formatSummary([{ path: "a.md", disk: "skip", remote: "skip" }]),
    "",
  );
});

test("format: formatTimeAgo renders expected buckets", () => {
  const now = Date.now();
  assert.equal(formatTimeAgo(new Date(now - 4_000)), "just now");
  assert.equal(formatTimeAgo(new Date(now - 30_000)), "30s ago");
  assert.equal(formatTimeAgo(new Date(now - 90_000)), "1m ago");
  assert.equal(formatTimeAgo(new Date(now - 3_600_000)), "1h ago");
});

test("format: formatCountdown renders seconds remaining", () => {
  const now = Date.now();
  assert.equal(formatCountdown(new Date(now + 27_000)), "27s");
});

test("format: formatCountdown renders minutes when >= 60s", () => {
  const now = Date.now();
  assert.equal(formatCountdown(new Date(now + 90_000)), "1m");
});

test("format: formatCountdown returns 0s for past target", () => {
  assert.equal(formatCountdown(new Date(Date.now() - 5_000)), "0s");
});
