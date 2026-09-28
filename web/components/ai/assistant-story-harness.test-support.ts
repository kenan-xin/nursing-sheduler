import { setAssistantDb } from "@/lib/ai/assistant/db";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY, TEST_MODEL } from "@/lib/ai/assistant/test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { scenarioCommands } from "@/lib/store";
import { withScenarioStore } from "../../.storybook/harness";

// Story `beforeEach` for assistant stories (bead w0e.6). `.storybook/` cannot import assistant
// code (the AI-optional boundary), so this lives inside the seam, listed by exact path in
// `.oxlintrc.json`. One uniquely named database (from `withScenarioStore`) serves both the
// scenario authority and the assistant tables, so parallel story files never share assistant
// state. Mirrors `makeReady()` in `assistant-panel.test.tsx`. Assistant stories must not also
// set `parameters.scenario`: pass `scenario` here instead.
export function withAssistant({
  ready = true,
  scenario,
}: { ready?: boolean; scenario?: Partial<ScenarioUiState> } = {}) {
  return async () => {
    const releaseScenario = await withScenarioStore(async (harness) => {
      setAssistantDb(harness.db);
      if (scenario) await scenarioCommands.mutate(scenario);
    })();
    assistantActions.resetForTest();
    await hydrateAssistant();
    if (ready) {
      await assistantActions.setEnabled(true);
      await assistantActions.activate({
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
      });
    }
    return async () => {
      assistantActions.resetForTest();
      setAssistantDb(null);
      await releaseScenario();
    };
  };
}
