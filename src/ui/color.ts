type ColorFn = (s: string) => string;

export type Colors = {
  dim: ColorFn;
  yellow: ColorFn;
  green: ColorFn;
  red: ColorFn;
};

const identity: ColorFn = (s) => s;

function wrap(code: string): ColorFn {
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

export function createColors(stream: NodeJS.WriteStream): Colors {
  if (!stream.isTTY) {
    return { dim: identity, yellow: identity, green: identity, red: identity };
  }

  return {
    dim: wrap("2"),
    yellow: wrap("33"),
    green: wrap("32"),
    red: wrap("31"),
  };
}
