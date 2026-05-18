import { InvalidUriError } from "./errors.ts";

export function parseUri(uri: string): { provider: string; config: { id: string } } {
  const separator = uri.indexOf(":");
  if (separator < 0) {
    throw new InvalidUriError(uri);
  }
  const provider = uri.slice(0, separator);
  const id = uri.slice(separator + 1);
  if (!provider) {
    throw new InvalidUriError(uri, "missing provider before ':'");
  }
  if (!id) {
    throw new InvalidUriError(uri, "missing id after ':'");
  }
  return {
    provider,
    config: {
      id,
    },
  };
}
