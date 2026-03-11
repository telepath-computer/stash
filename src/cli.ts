#!/usr/bin/env node
import { main } from "./cli-main.ts";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
