import { createHash } from "node:crypto";

export function hashBuffer(buffer: Buffer): string {
  const digest = createHash("sha256").update(buffer).digest("hex");
  return `sha256-${digest}`;
}

export function hashText(content: string): string {
  return hashBuffer(Buffer.from(content, "utf8"));
}
