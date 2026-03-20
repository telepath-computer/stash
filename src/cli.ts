#!/usr/bin/env node
import { CliDisplayError } from "./cli-display-error.ts";
import { main } from "./cli-main.ts";

main().catch((error) => {
  if (error instanceof CliDisplayError) {
    error.writeTo(process.stderr);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
