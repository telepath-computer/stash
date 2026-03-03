import type { Disposable } from "@rupertsworld/disposable";
import type { FileMutation } from "../types.ts";
import { directionArrow, formatSummary, mutationDirection } from "./format.ts";
import { LiveLine } from "./live-line.ts";

export class SyncRenderer implements Disposable {
  private readonly line: LiveLine;
  private readonly mutations: FileMutation[] = [];
  private spinnerRunning = false;

  constructor(line: LiveLine) {
    this.line = line;
  }

  onMutation(mutation: FileMutation): void {
    if (mutation.disk === "skip" && mutation.remote === "skip") {
      return;
    }

    this.mutations.push(mutation);
    const direction = mutationDirection(mutation);
    const text = `syncing... ${directionArrow(direction)} ${mutation.path}`;
    if (!this.spinnerRunning) {
      this.spinnerRunning = true;
      this.line.startSpinner(text);
      return;
    }

    this.line.spinnerText(text);
  }

  done(): string {
    this.line.stopSpinner();
    this.spinnerRunning = false;
    return formatSummary(this.mutations);
  }

  error(_err: Error): void {
    this.line.stopSpinner();
    this.spinnerRunning = false;
  }

  dispose(): void {
    this.line.stopSpinner();
    this.spinnerRunning = false;
  }
}
