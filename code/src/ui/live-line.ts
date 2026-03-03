import type { Disposable } from "@rupertsworld/disposable";
import { createColors, type Colors } from "./color.ts";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const SPINNER_INTERVAL_MS = 80;

export class LiveLine implements Disposable {
  private readonly stream: NodeJS.WriteStream;
  readonly colors: Colors;
  private spinnerIndex = 0;
  private spinnerBody = "";
  private spinnerTimer: NodeJS.Timeout | null = null;

  constructor(stream: NodeJS.WriteStream) {
    this.stream = stream;
    this.colors = createColors(stream);
  }

  update(text: string): void {
    if (!this.stream.isTTY) {
      return;
    }
    this.stream.write(`\r\x1b[2K${text}`);
  }

  print(text: string): void {
    if (this.stream.isTTY) {
      this.stream.write(`\r\x1b[2K${text}\n`);
      return;
    }
    this.stream.write(`${text}\n`);
  }

  startSpinner(text: string): void {
    if (!this.stream.isTTY) {
      return;
    }
    this.spinnerBody = text;
    if (this.spinnerTimer) {
      this.renderSpinner();
      return;
    }

    this.spinnerIndex = 0;
    this.renderSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      this.renderSpinner();
    }, SPINNER_INTERVAL_MS);
  }

  spinnerText(text: string): void {
    this.spinnerBody = text;
    if (!this.stream.isTTY || !this.spinnerTimer) {
      return;
    }
    this.renderSpinner();
  }

  stopSpinner(): void {
    if (!this.spinnerTimer) {
      return;
    }
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  dispose(): void {
    this.stopSpinner();
  }

  private renderSpinner(): void {
    const frame = this.colors.yellow(SPINNER_FRAMES[this.spinnerIndex]);
    this.update(`${frame} ${this.spinnerBody}`);
  }
}
