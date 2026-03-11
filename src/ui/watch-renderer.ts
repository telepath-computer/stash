import type { Disposable } from "@rupertsworld/disposable";
import { Stash } from "../stash.ts";
import type { WatchStatus } from "../watch.ts";
import { formatCountdown } from "./format.ts";
import { LiveLine } from "./live-line.ts";
import { SyncRenderer } from "./sync-renderer.ts";

export class WatchRenderer implements Disposable {
  private readonly line: LiveLine;
  private readonly dir: string;
  private readonly isTTY: boolean;

  constructor(line: LiveLine, dir: string, isTTY: boolean) {
    this.line = line;
    this.dir = dir;
    this.isTTY = isTTY;
  }

  startSync(stash: Stash): Disposable {
    const renderer = new SyncRenderer(this.line);
    const subscription = stash.on("mutation", (mutation) => {
      renderer.onMutation(mutation);
    });

    this.line.startSpinner("checking...");

    return {
      dispose: () => {
        subscription.dispose();
        renderer.dispose();
      },
    };
  }

  onStatus(status: WatchStatus): void {
    const { dim, green, red } = this.line.colors;
    if (!this.isTTY) {
      if (status.kind === "synced") {
        this.line.print(`✓ synced (${status.summary})`);
        return;
      }
      if (status.kind === "checked") {
        this.line.print("✓ up to date");
        return;
      }
      this.line.print(`${red("✗")} sync failed: ${status.error}`);
      return;
    }

    if (status.kind === "synced") {
      this.line.update(
        `${green("●")} ${status.summary} ${dim("·")} ${dim(`checking in ${formatCountdown(status.nextCheck)}`)}`,
      );
      return;
    }
    if (status.kind === "checked") {
      this.line.update(
        `${green("●")} ${dim("up to date")} ${dim("·")} ${dim(`checking in ${formatCountdown(status.nextCheck)}`)}`,
      );
      return;
    }
    this.line.update(
      `${red("✗")} sync failed: ${status.error} ${dim("·")} ${dim(`retrying in ${formatCountdown(status.nextCheck)}`)}`,
    );
  }

  printWatching(): void {
    this.line.print(this.line.colors.dim(`watching ${this.dir} (. to sync, q to quit)`));
  }

  printStopped(): void {
    this.line.print(this.line.colors.dim(`stopped watching ${this.dir}`));
  }

  dispose(): void {
    this.line.dispose();
  }
}
