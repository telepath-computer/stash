import { InvalidUriError } from "./errors.ts";

export function parseUri(uri: string): { provider: string; config: { id: string } } {
  const separator = uri.indexOf(":");
  if (separator < 0) {
    throw new InvalidUriError(uri);
  }
  return {
    provider: uri.slice(0, separator),
    config: {
      id: uri.slice(separator + 1),
    },
  };
}
