import "fake-indexeddb/auto";
import { vi } from "vitest";
import { SINGAPORE_CASES } from "./cases/singapore.case";
import { runCases } from "./lib/runner";

const seams = vi.hoisted(() => ({ agent: null as unknown, pushes: [] as string[] }));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    push: (path: string) => {
      seams.pushes.push(path);
      window.history.replaceState({}, "", path);
    },
    replace: () => undefined,
    prefetch: () => undefined,
  }),
}));
vi.mock("@copilotkit/react-core/v2", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgent: () => ({ agent: seams.agent, isReady: true }),
}));

runCases(SINGAPORE_CASES, seams);
