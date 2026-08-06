// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AI_KEY_HEADER, AI_MODEL_HEADER, AI_SETUP_CODES } from "@/lib/ai/protocol";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  dumpDatabase,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import { AiAssistantCard } from "./ai-assistant-card";

// The sentinel is a string that must reach exactly one place: the probe request's
// credential header. Not the DOM, not a console line, and — in the database — only
// the assistant-settings row.
const UPSTREAM_LEAK = "UPSTREAM-BODY account=ward-manager@example.test";

let harness: AssistantHarness;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleOutput: string[];

function catalogResponse(): Response {
  return new Response(
    JSON.stringify({
      source: "catalog",
      fallbackVersion: 1,
      models: [
        { id: TEST_MODEL, name: "Claude Sonnet 4.5", contextLength: 200000 },
        { id: "openai/gpt-4.1", name: "GPT-4.1", contextLength: 1000000 },
      ],
      recommendedId: TEST_MODEL,
    }),
    { status: 200 },
  );
}

/** Route the card's two fetches; anything else is an unexpected egress. */
function installFetch(options: { probe?: () => Response; catalog?: () => Response } = {}) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/ai/openrouter/models")) {
      return (options.catalog ?? catalogResponse)();
    }
    if (url.includes("/api/ai/openrouter/test")) {
      void init;
      return (
        options.probe ?? (() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      )();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiAssistantCard />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  consoleOutput = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });
  }
  installFetch();
  await hydrateAssistant();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("disabled (the default)", () => {
  it("shows only the toggle, and fetches nothing from a third party", async () => {
    renderCard();

    expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Off");
    expect(screen.queryByTestId("ai-credential-field")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-test")).not.toBeInTheDocument();
    // An off-by-default feature must not reach out for a model catalogue on an
    // ordinary Settings visit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never claims the browser store is encrypted or secure", async () => {
    await assistantActions.setEnabled(true);
    renderCard();

    const copy = screen.getByTestId("ai-credential-field").textContent ?? "";
    expect(copy).toMatch(/not encrypted/i);
    for (const forbidden of ["securely", "secure storage", "safely stored"]) {
      expect(copy.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("draft → testing → Ready", () => {
  beforeEach(async () => {
    await assistantActions.setEnabled(true);
  });

  it("is not Ready on a draft alone, and becomes Ready only after a passing probe", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    // A typed draft is not readiness.
    expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Needs a tested key");
    expect(await readAssistantSettings(harness.config)).toMatchObject({ apiKey: null });

    await user.click(screen.getByTestId("ai-test"));

    await waitFor(() => {
      expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Ready");
    });
    expect(await readAssistantSettings(harness.config)).toMatchObject({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });
  });

  it("sends the credential to the probe as a header, never as a body or a query", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-test"));
    await waitFor(() => expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Ready"));

    const probeCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/test"));
    const [url, init] = probeCall as unknown as [string, RequestInit];
    expect(url).not.toContain(SENTINEL_KEY);
    expect(String(init.body ?? "")).not.toContain(SENTINEL_KEY);
    expect((init.headers as Record<string, string>)[AI_KEY_HEADER]).toBe(SENTINEL_KEY);
    expect((init.headers as Record<string, string>)[AI_MODEL_HEADER]).toBe(TEST_MODEL);
  });

  it("shows a testing state while the probe is in flight", async () => {
    let release: (() => void) | undefined;
    installFetch({
      probe: () => {
        throw new Error("unused");
      },
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/models")) return catalogResponse();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    renderCard();
    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-test"));

    expect(screen.getByTestId("ai-test")).toHaveTextContent("Testing…");
    expect(screen.getByTestId("ai-probe-status")).toHaveTextContent("Checking the key");
    release?.();
  });
});

describe("failed probe", () => {
  beforeEach(async () => {
    await assistantActions.setEnabled(true);
  });

  it.each([
    [AI_SETUP_CODES.credentialsRejected, /did not accept this key/i],
    [AI_SETUP_CODES.modelLacksTools, /cannot use the tools/i],
    [AI_SETUP_CODES.modelUnavailable, /does not offer this model/i],
    [AI_SETUP_CODES.providerDeclined, /spend or rate limit/i],
    [AI_SETUP_CODES.providerUnreachable, /could not be reached/i],
  ])("names what failed for %s", async (code, expected) => {
    installFetch({
      probe: () => new Response(JSON.stringify({ ok: false, code }), { status: 200 }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-test"));

    await waitFor(() => {
      expect(screen.getByTestId("ai-probe-status").textContent ?? "").toMatch(expected);
    });
    // Nothing durable changed, so nothing became Ready.
    expect(screen.getByTestId("ai-readiness")).not.toHaveTextContent("Ready");
    expect(await readAssistantSettings(harness.config)).toMatchObject({ apiKey: null });
  });

  it("leaks no upstream body into the DOM or the console", async () => {
    installFetch({
      probe: () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: AI_SETUP_CODES.credentialsRejected,
            // A hostile/verbose server answering with extra detail must not be rendered.
            detail: UPSTREAM_LEAK,
          }),
          { status: 200 },
        ),
    });
    const user = userEvent.setup();
    const { container } = renderCard();

    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-test"));
    await waitFor(() =>
      expect(screen.getByTestId("ai-probe-status")).toHaveTextContent(/did not accept/i),
    );

    expect(container.innerHTML).not.toContain("UPSTREAM-BODY");
    expect(container.innerHTML).not.toContain("ward-manager@example.test");
    expect(consoleOutput.join("\n")).not.toContain("UPSTREAM-BODY");
  });

  it("leaves a previously working configuration intact", async () => {
    await assistantActions.activate({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });
    installFetch({
      probe: () =>
        new Response(JSON.stringify({ ok: false, code: AI_SETUP_CODES.credentialsRejected }), {
          status: 200,
        }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId("ai-test"));
    await waitFor(() =>
      expect(screen.getByTestId("ai-probe-status")).toHaveTextContent(/did not accept/i),
    );

    expect(await readAssistantSettings(harness.config)).toMatchObject({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
    });
  });
});

describe("catalog unavailable and fallback", () => {
  beforeEach(async () => {
    await assistantActions.setEnabled(true);
  });

  it("stays usable when the catalog route fails", async () => {
    installFetch({ catalog: () => new Response("nope", { status: 500 }) });
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("ai-catalog-unavailable")).toBeInTheDocument();
    });
    // The escape hatch is still there, so setup is never dead-ended.
    expect(screen.getByTestId("ai-custom-slug-toggle")).toBeInTheDocument();
  });

  it("says so when the built-in list is being shown", async () => {
    installFetch({
      catalog: () =>
        new Response(
          JSON.stringify({
            source: "fallback",
            fallbackVersion: 1,
            models: [{ id: TEST_MODEL, name: "Claude Sonnet 4.5", contextLength: null }],
            recommendedId: TEST_MODEL,
          }),
          { status: 200 },
        ),
    });
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("ai-catalog-fallback")).toBeInTheDocument();
    });
  });

  it("caps a very long catalog and SAYS it capped it", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `vendor/model-${String(index).padStart(3, "0")}`,
      name: `Model ${String(index).padStart(3, "0")}`,
      contextLength: null,
    }));
    installFetch({
      catalog: () =>
        new Response(
          JSON.stringify({
            source: "catalog",
            fallbackVersion: 1,
            models: many,
            recommendedId: many[0].id,
          }),
          { status: 200 },
        ),
    });
    renderCard();

    await waitFor(() => expect(screen.getByTestId("ai-model-truncated")).toBeInTheDocument());
    const options = screen.getByTestId("ai-model-select").querySelectorAll("option");
    // A silently truncated list would read as "these are all the models there are".
    expect(screen.getByTestId("ai-model-truncated")).toHaveTextContent(`of ${many.length}`);
    expect(options.length).toBeLessThan(many.length);
    // The shown value is one of the shown options, so the draft cannot differ from
    // what the user can see.
    expect(Array.from(options).map((o) => o.getAttribute("value"))).toContain(
      (screen.getByTestId("ai-model-select") as HTMLSelectElement).value,
    );
  });

  it("follows the visible options when a search excludes the current preference", async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("ai-model-select").querySelectorAll("option")).toHaveLength(2),
    );
    const select = screen.getByTestId("ai-model-select") as HTMLSelectElement;
    expect(select.value).toBe(TEST_MODEL);

    await user.type(screen.getByTestId("ai-model-search"), "gpt");

    // The recommended default is filtered out, so the effective choice becomes the
    // one option that IS shown — not a value the user cannot see.
    expect(select.value).toBe("openai/gpt-4.1");
  });

  it("filters the list as the user searches", async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("ai-model-select").querySelectorAll("option")).toHaveLength(2),
    );

    await user.type(screen.getByTestId("ai-model-search"), "gpt");

    const options = screen.getByTestId("ai-model-select").querySelectorAll("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveValue("openai/gpt-4.1");
  });
});

describe("custom slug escape hatch", () => {
  beforeEach(async () => {
    await assistantActions.setEnabled(true);
  });

  it("warns about compatibility and records the source as custom once probed", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-custom-slug-toggle"));
    expect(screen.getByText(/may not support tools/i)).toBeInTheDocument();

    await user.type(screen.getByTestId("ai-custom-slug-input"), "vendor/experimental");
    await user.click(screen.getByTestId("ai-test"));

    await waitFor(() => expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Ready"));
    expect(await readAssistantSettings(harness.config)).toMatchObject({
      modelId: "vendor/experimental",
      modelSource: "custom",
    });
  });

  it("blocks a custom model that fails its probe rather than half-enabling it", async () => {
    installFetch({
      probe: () =>
        new Response(JSON.stringify({ ok: false, code: AI_SETUP_CODES.modelLacksTools }), {
          status: 200,
        }),
    });
    const user = userEvent.setup();
    renderCard();

    await user.type(screen.getByTestId("ai-key-input"), SENTINEL_KEY);
    await user.click(screen.getByTestId("ai-custom-slug-toggle"));
    await user.type(screen.getByTestId("ai-custom-slug-input"), "vendor/no-tools");
    await user.click(screen.getByTestId("ai-test"));

    await waitFor(() =>
      expect(screen.getByTestId("ai-probe-status")).toHaveTextContent(/cannot use the tools/i),
    );
    expect(await readAssistantSettings(harness.config)).toMatchObject({ apiKey: null });
  });
});

describe("replace and remove", () => {
  beforeEach(async () => {
    await assistantActions.setEnabled(true);
    await assistantActions.activate({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });
  });

  it("shows a stored key as a mask, never re-rendered into an input", async () => {
    const { container } = renderCard();

    expect(screen.getByTestId("ai-key-mask")).toHaveTextContent("0001");
    expect(screen.queryByTestId("ai-key-input")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(SENTINEL_KEY);
  });

  it("replaces the credential only through a fresh passing probe", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByTestId("ai-key-input"), "sk-or-REPLACEMENT-0002");
    await user.click(screen.getByTestId("ai-test"));

    await waitFor(() => expect(screen.getByTestId("ai-key-mask")).toHaveTextContent("0002"));
    expect(await readAssistantSettings(harness.config)).toMatchObject({
      apiKey: "sk-or-REPLACEMENT-0002",
    });
  });

  it("removes the key immediately, keeps the model, and drops readiness", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId("ai-remove-key"));

    await waitFor(() =>
      expect(screen.getByTestId("ai-readiness")).toHaveTextContent("Needs a tested key"),
    );
    const stored = await readAssistantSettings(harness.config);
    expect(stored.apiKey).toBeNull();
    expect(stored.modelId).toBe(TEST_MODEL);
  });

  it("keeps the credential out of every table but the settings row", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByTestId("ai-key-mask")).toBeInTheDocument());

    const dump = await dumpDatabase(harness.db);
    for (const [table, contents] of Object.entries(dump)) {
      if (table === "assistantSettings") continue;
      expect(contents, `${table} contains the credential`).not.toContain(SENTINEL_KEY);
    }
    expect(consoleOutput.join("\n")).not.toContain(SENTINEL_KEY);
    expect(document.cookie).not.toContain(SENTINEL_KEY);
  });
});
