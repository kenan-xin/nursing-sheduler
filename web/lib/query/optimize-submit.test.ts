import { afterEach, describe, expect, it, vi } from "vitest";

import { postOptimizeJob } from "@/lib/query/optimize";

// Bug hunt BH4 / D-06: the backend caps a plain form FIELD at 1 MiB (Starlette's
// default part limit) but a FILE part at the stated 2 MiB, so the scenario must be
// sent as a file. Its bytes must still be the newline-normalized form the basis
// digest was taken over (`toTransmittedYaml`), or every claim would fail to verify.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("postOptimizeJob -- multipart shape", () => {
  it("sends the YAML as a file part carrying the transmitted bytes", async () => {
    let sent: FormData | undefined;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent = init?.body as FormData;
      return new Response("{}", { status: 413 });
    }) as typeof fetch;

    await postOptimizeJob({ yamlContent: "a: 1\nb: 2\r\n" }).catch(() => {});

    expect(sent?.has("yaml_content")).toBe(false);
    const part = sent?.get("file");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toMatch(/\.yaml$/);
    expect(await (part as File).text()).toBe("a: 1\r\nb: 2\r\n");
  });
});
