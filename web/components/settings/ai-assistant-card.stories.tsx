import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import { assistantActions, selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY, TEST_MODEL } from "@/lib/ai/assistant/test-support";
import { withToaster } from "../../.storybook/harness";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  jsonResponse,
  withFetchRoutes,
  type FetchRoute,
} from "../../.storybook/story-helpers";
import { withAssistant } from "../ai/assistant-story-harness.test-support";
import { AiAssistantCard } from "./ai-assistant-card";

// The card's only two requests, routed as ai-assistant-card.test.tsx's `installFetch`
// routes them: the model catalogue and the key probe. Anything else fails the story.
const CATALOG = {
  source: "catalog",
  fallbackVersion: 1,
  models: [
    { id: TEST_MODEL, name: "Claude Sonnet 4.5", contextLength: 200000 },
    { id: "openai/gpt-4.1", name: "GPT-4.1", contextLength: 1000000 },
  ],
  recommendedId: TEST_MODEL,
};
const probe = fn(() => jsonResponse(200, { ok: true }));

const routes = (catalog: () => Response = () => jsonResponse(200, CATALOG)): FetchRoute[] => [
  ["/api/ai/openrouter/models", catalog],
  ["/api/ai/openrouter/test", probe],
];

const meta = {
  title: "Settings/AiAssistantCard",
  component: AiAssistantCard,
  parameters: { layout: "padded" },
  decorators: [
    withToaster,
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => probe.mockClear(),
} satisfies Meta<typeof AiAssistantCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const enabled = () => assistantActions.setEnabled(true);

// Off by default, and an ordinary Settings visit reaches no third party.
export const Off: Story = {
  beforeEach: [withAssistant({ ready: false }), withFetchRoutes([])],
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("ai-readiness")).toHaveTextContent("Off");
    await expect(canvas.queryByTestId("ai-credential-field")).toBeNull();
  },
};

export const EnableAndKey: Story = {
  beforeEach: [withAssistant({ ready: false }), withFetchRoutes(routes())],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("ai-enabled-switch"));
    await userEvent.type(await canvas.findByTestId("ai-key-input"), SENTINEL_KEY);
    await expect(canvas.getByTestId("ai-readiness")).toHaveTextContent("Needs a tested key");
    await userEvent.click(canvas.getByTestId("ai-test"));
    await waitFor(() => expect(canvas.getByTestId("ai-readiness")).toHaveTextContent("Ready"));
    await expect(selectReady(useAssistantStore.getState())).toBe(true);
    await expect(probe).toHaveBeenCalledOnce();
    // The key travels as a header only, never in the URL.
    const [url] = probe.mock.calls[0] as unknown as [string];
    await expect(url).not.toContain(SENTINEL_KEY);
  },
};

export const CatalogUnavailable: Story = {
  beforeEach: [
    withAssistant({ ready: false }),
    withFetchRoutes(routes(() => new Response("nope", { status: 500 }))),
    enabled,
  ],
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByTestId("ai-catalog-unavailable", {}, { timeout: 15000 }),
    ).toBeVisible();
    await expect(canvas.getByTestId("ai-custom-slug-toggle")).toBeVisible();
  },
};

export const CatalogFallback: Story = {
  beforeEach: [
    withAssistant({ ready: false }),
    withFetchRoutes(
      routes(() =>
        jsonResponse(200, {
          ...CATALOG,
          source: "fallback",
          models: [{ id: TEST_MODEL, name: "Claude Sonnet 4.5", contextLength: null }],
        }),
      ),
    ),
    enabled,
  ],
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("ai-catalog-fallback")).toBeVisible();
  },
};

export const ClearHistory: Story = {
  beforeEach: [withAssistant(), withFetchRoutes(routes())],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("ai-clear-history"));
    await expect(canvas.getByTestId("ai-clear-confirm")).toBeVisible();
    await userEvent.click(canvas.getByTestId("ai-clear-confirm-yes"));
    await waitFor(() => expect(canvas.queryByTestId("ai-clear-confirm")).toBeNull());
    await expect(canvas.queryByTestId("ai-clear-incomplete")).toBeNull();
  },
};

// A clear that did not complete names what is left and offers a retry.
export const ClearIncomplete: Story = {
  beforeEach: [
    withAssistant(),
    withFetchRoutes(routes()),
    () => {
      useAssistantStore.setState({
        clearResult: {
          status: "incomplete",
          scope: "all",
          scenarioId: null,
          reason: "recapture_exhausted",
          configurationOutcome: "deleted",
          operationId: "op-all-0001",
        },
      });
    },
  ],
  play: async ({ canvas }) => {
    const notice = canvas.getByTestId("ai-clear-incomplete");
    await expect(notice).toHaveTextContent("Some AI data could not be cleared");
    await expect(canvas.getByTestId("ai-clear-retry")).toHaveTextContent("Try clearing again");
  },
};

export const LongText: Story = {
  beforeEach: [withAssistant({ ready: false }), withFetchRoutes(routes()), enabled],
  decorators: [
    (Story) => (
      <div data-testid="frame" className="w-80">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByTestId("ai-custom-slug-toggle"));
    await userEvent.type(canvas.getByTestId("ai-custom-slug-input"), LONG_TOKEN);
    await expectNoHorizontalOverflow(canvas.getByTestId("frame"));
  },
};

export const Dark: Story = {
  beforeEach: [withAssistant(), withFetchRoutes(routes())],
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("ai-readiness")).toHaveTextContent("Ready");
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
