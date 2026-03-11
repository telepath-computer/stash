type PathMatcher = string | RegExp;

export interface MockResponse {
  status: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Entry = {
  method: string;
  path: PathMatcher;
  handler: (args: { body: unknown; headers: Headers; url: URL }) => MockResponse;
  called: number;
};

function toResponse(res: MockResponse): Response {
  if (res.body === undefined) {
    return new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (Buffer.isBuffer(res.body)) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (typeof res.body === "string") {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    statusText: res.statusText,
    headers: { "content-type": "application/json", ...(res.headers ?? {}) },
  });
}

function matches(path: PathMatcher, value: string): boolean {
  if (typeof path === "string") {
    return value === path;
  }
  return path.test(value);
}

export class MockGitHubAPI {
  private readonly entries: Entry[] = [];
  private originalFetch: typeof globalThis.fetch | null = null;

  on(method: string, path: PathMatcher, response: MockResponse): this {
    this.entries.push({
      method: method.toUpperCase(),
      path,
      called: 0,
      handler: () => response,
    });
    return this;
  }

  onRequest(
    method: string,
    path: PathMatcher,
    handler: (args: { body: unknown; headers: Headers; url: URL }) => MockResponse,
  ): this {
    this.entries.push({
      method: method.toUpperCase(),
      path,
      called: 0,
      handler,
    });
    return this;
  }

  onPost(path: PathMatcher, handler: (body: unknown) => MockResponse): this {
    this.entries.push({
      method: "POST",
      path,
      called: 0,
      handler: ({ body }) => handler(body),
    });
    return this;
  }

  install(): () => void {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string" || input instanceof URL
          ? new URL(input.toString())
          : new URL(input.url);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const path = `${requestUrl.pathname}${requestUrl.search}`;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );

      let parsedBody: unknown;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }

      const entry = this.entries.find((candidate) => {
        return candidate.method === method && matches(candidate.path, path);
      });
      if (!entry) {
        throw new Error(`Unexpected request: ${method} ${path}`);
      }

      entry.called += 1;
      return toResponse(entry.handler({ body: parsedBody, headers, url: requestUrl }));
    };

    return () => {
      if (this.originalFetch) {
        globalThis.fetch = this.originalFetch;
      }
      this.originalFetch = null;
    };
  }

  assertDone(): void {
    for (const entry of this.entries) {
      if (entry.called === 0) {
        throw new Error(`Expected call not made: ${entry.method} ${entry.path.toString()}`);
      }
    }
  }
}
