import test from "node:test";
import assert from "node:assert/strict";
import { SyncRenderer } from "../../src/ui/sync-renderer.ts";

function makeLineMock() {
  return {
    startSpinnerCalls: [] as string[],
    spinnerTextCalls: [] as string[],
    stopSpinnerCalls: 0,
    printCalls: [] as string[],
    startSpinner(text: string) {
      this.startSpinnerCalls.push(text);
    },
    spinnerText(text: string) {
      this.spinnerTextCalls.push(text);
    },
    stopSpinner() {
      this.stopSpinnerCalls += 1;
    },
    print(text: string) {
      this.printCalls.push(text);
    },
  };
}

test("sync-renderer: accumulates mutations and returns summary", () => {
  const line = makeLineMock();
  const renderer = new SyncRenderer(line as any);

  renderer.onMutation({ path: "a.md", disk: "skip", remote: "write" });
  renderer.onMutation({ path: "b.md", disk: "write", remote: "skip" });
  renderer.onMutation({ path: "c.md", disk: "write", remote: "write" });

  assert.equal(renderer.done(), "1↑ 1↓ 1↑↓");
  assert.equal(line.startSpinnerCalls.length, 1);
  assert.equal(line.spinnerTextCalls.length, 2);
});

test("sync-renderer: done with no mutations returns empty summary", () => {
  const line = makeLineMock();
  const renderer = new SyncRenderer(line as any);
  assert.equal(renderer.done(), "");
});

test("sync-renderer: error stops spinner and does not print", () => {
  const line = makeLineMock();
  const renderer = new SyncRenderer(line as any);
  renderer.error(new Error("boom"));
  assert.equal(line.stopSpinnerCalls, 1);
  assert.deepEqual(line.printCalls, []);
});
