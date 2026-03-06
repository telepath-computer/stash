import test from "node:test";
import assert from "node:assert/strict";
import { collectFields } from "../../src/cli.ts";
import type { Field } from "../../src/types.ts";

type PromptCall = { field: Field; message: string };

function makePrompt(responses: string[]): {
  prompt: (field: Field, message: string) => Promise<string>;
  calls: PromptCall[];
} {
  const calls: PromptCall[] = [];
  let idx = 0;
  return {
    prompt: async (field: Field, message: string) => {
      calls.push({ field, message });
      return responses[idx++] ?? "";
    },
    calls,
  };
}

test("collectFields: prompts to replace existing secret field", async () => {
  const { prompt, calls } = makePrompt(["ghp_new456"]);
  const fields: Field[] = [{ name: "token", label: "Personal access token", secret: true }];
  const result = await collectFields(fields, {}, { token: "ghp_abc123" }, prompt);
  assert.equal(result.token, "ghp_new456");
  assert.equal(calls.length, 1);
});

test("collectFields: keeps existing value on empty input", async () => {
  const { prompt } = makePrompt([""]);
  const fields: Field[] = [{ name: "token", label: "Personal access token", secret: true }];
  const result = await collectFields(fields, {}, { token: "ghp_abc123" }, prompt);
  assert.equal(result.token, "ghp_abc123");
});

test("collectFields: CLI flag overrides without prompting", async () => {
  const { prompt, calls } = makePrompt([]);
  const fields: Field[] = [{ name: "token", label: "Personal access token", secret: true }];
  const result = await collectFields(fields, { token: "ghp_flag789" }, { token: "ghp_abc123" }, prompt);
  assert.equal(result.token, "ghp_flag789");
  assert.equal(calls.length, 0);
});

test("collectFields: prompt message masks secret field", async () => {
  const { prompt, calls } = makePrompt([""]);
  const fields: Field[] = [{ name: "token", label: "Personal access token", secret: true }];
  await collectFields(fields, {}, { token: "ghp_abc123" }, prompt);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /\*\*\*\*c123/);
});

test("collectFields: prompt message shows full value for non-secret field", async () => {
  const { prompt, calls } = makePrompt([""]);
  const fields: Field[] = [{ name: "repo", label: "Repository (user/repo)" }];
  await collectFields(fields, {}, { repo: "user/repo" }, prompt);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /current: user\/repo/);
});
