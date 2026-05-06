import type { Readable, Writable } from "node:stream";
import {
  cancel as clackCancel,
  intro as clackIntro,
  isCancel,
  log,
  outro as clackOutro,
  password,
  text,
} from "@clack/prompts";
import picocolors from "picocolors";

export class CliCommandError extends Error {
  readonly summary: string;
  readonly details: string[];
  readonly finalLine: string;

  constructor(summary: string, details: string[] = [], finalLine = "No changes made.") {
    super(summary);
    this.name = "CliCommandError";
    this.summary = summary;
    this.details = details;
    this.finalLine = finalLine;
  }
}

export function cliError(
  summary: string,
  details: string[] = [],
  finalLine = "No changes made.",
): CliCommandError {
  return new CliCommandError(summary, details, finalLine);
}

export type CliUi = ReturnType<typeof createCliUi>;

export function shortenHomePath(path: string, home = process.env.HOME): string {
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function createCliUi({
  input = process.stdin,
  output = process.stdout,
}: {
  input?: Readable;
  output?: Writable;
} = {}) {
  const colors = picocolors.createColors(Boolean((output as NodeJS.WriteStream).isTTY));

  const common = {
    input,
    output,
  } as const;

  return {
    input,
    output,
    colors,
    intro(title: string): void {
      clackIntro(title, { output });
    },
    step(message: string): void {
      log.step(message, { output });
    },
    message(message: string | string[]): void {
      log.message(message, { output });
    },
    outro(message: string): void {
      clackOutro(message, { output });
    },
    cancel(message: string): void {
      clackCancel(message, { output });
    },
    async promptText(label: string): Promise<string> {
      const value = await text({
        message: label,
        ...common,
        validate: (candidate) => {
          if (!candidate || candidate.trim().length === 0) {
            return `${label} is required`;
          }
          return undefined;
        },
      });
      if (isCancel(value)) {
        throw cliError("Prompt cancelled.");
      }
      return value;
    },
    async promptPassword(label: string): Promise<string> {
      const value = await password({
        message: label,
        ...common,
        validate: (candidate) => {
          if (!candidate || candidate.trim().length === 0) {
            return `${label} is required`;
          }
          return undefined;
        },
      });
      if (isCancel(value)) {
        throw cliError("Prompt cancelled.");
      }
      return value;
    },
    renderError(error: CliCommandError): void {
      this.cancel(error.summary);
      if (error.details.length > 0) {
        this.message(error.details);
      }
      this.outro(error.finalLine);
    },
  };
}
