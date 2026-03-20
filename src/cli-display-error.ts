import { createColors } from "./ui/color.ts";

export type CliDisplayLine =
  | { kind: "primary"; text: string }
  | { kind: "dim"; text: string }
  | { kind: "blank" };

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}

/** Plain text for `Error.message` (no ANSI), used by tests and logging. */
function plainTextFromLines(lines: CliDisplayLine[]): string {
  return lines.map((l) => (l.kind === "blank" ? "" : l.text)).join("\n");
}

/**
 * Terminal-oriented CLI error: first line in red (TTY), continuation in dim.
 * `writeTo` is used by the `stash` entrypoint; programmatic `main()` callers
 * still receive a normal `throw` with a readable `.message`.
 */
export class CliDisplayError extends Error {
  readonly lines: CliDisplayLine[];

  constructor(lines: CliDisplayLine[]) {
    super(plainTextFromLines(lines));
    this.name = "CliDisplayError";
    this.lines = lines;
  }

  writeTo(stream: NodeJS.WriteStream): void {
    const { dim, red } = createColors(stream);
    for (const line of this.lines) {
      if (line.kind === "blank") {
        writeLine(stream, "");
        continue;
      }
      if (line.kind === "primary") {
        writeLine(stream, red(line.text));
        continue;
      }
      writeLine(stream, dim(line.text));
    }
  }
}
