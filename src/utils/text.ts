export function isValidText(buffer: Buffer): boolean {
  if (buffer.includes(0x00)) {
    return false;
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}
