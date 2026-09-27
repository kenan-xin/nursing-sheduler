import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import type { JobResponse } from "@/lib/bff/types";
import {
  OPTIMIZE_SESSION_STORAGE_KEY,
  resetRosterCaptureGate,
  type SessionCaptureState,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import type { PrepareOptimizeSubmissionResult, ScenarioUiState } from "@/lib/scenario";
import { useHotStore } from "@/lib/store";
import { jsonResponse, sseResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import { OptimizeAndExportScreen } from "./optimize-and-export-screen";

// Every fake below is copied from optimize-and-export-screen.test.tsx; read it before editing.
// The write-ahead snapshot is DEGRADED (that file's premise), so no /roster request is made.
const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: "scenario: {}", peopleCount: 0, reverseMap: [], anonymized: false },
};
const degradedCapture = async (): Promise<SessionCaptureState> => ({
  status: "unavailable",
  reason: "snapshot_persist_failed",
});

// One session store per file, emptied before every story so no run record leaks.
const values = new Map<string, string>();
const storage: SessionTransactionStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => void values.set(key, value),
  removeItem: (key) => void values.delete(key),
  get length() {
    return values.size;
  },
  key: (index) => [...values.keys()][index] ?? null,
};

// A session store whose run slot is already occupied: staging fails closed
// (`session-conflict`), so the run is blocked before any POST.
const occupiedStorage: SessionTransactionStorage = {
  ...storage,
  getItem: () => "occupied",
  setItem: () => {},
};

function info(over: { status?: number; clientVersion?: string } = {}) {
  return {
    fetchInfo: async () =>
      over.status === 502
        ? { status: 502, body: { status: "unavailable", reason: "backend_unreachable" } }
        : {
            status: 200,
            body: {
              status: "ready",
              service_name: "nurse",
              api_version: "0.2.0",
              app_version: "1.0.0",
              deployment_id: "d",
              instance_id: "i",
              started_at: "2026-07-20T00:00:00+00:00",
              job_backend: "redis",
              job_store_id: "s",
            },
          },
    clientVersion: over.clientVersion ?? "1.0.0",
  };
}

const baseJob = (over: Partial<JobResponse> = {}): JobResponse => ({
  id: "opt_1",
  state: "queued",
  terminal: false,
  queue_position: 2,
  created_at: "2026-07-20T00:00:00+00:00",
  expires_at: null,
  started_at: null,
  finished_at: null,
  request: {
    input_name: "s.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 300,
    purpose: "ordinary",
    basis: null,
  },
  result: null,
  error: null,
  controls: { cancellable: true, early_completion_available: false },
  links: {
    self: "/optimize/opt_1",
    events: "/optimize/opt_1/events",
    cancellation: "/optimize/opt_1/cancel",
    early_completion: "/optimize/opt_1/finish-now",
    schedule: null,
  },
  ...over,
});

const completedJob = baseJob({
  state: "completed",
  terminal: true,
  started_at: "2026-07-20T00:00:01+00:00",
  finished_at: "2026-07-20T00:01:00+00:00",
  queue_position: null,
  result: {
    outcome: "optimal",
    score: 42,
    solver_status: "OPTIMAL",
    termination_reason: "optimality_proven",
  },
  controls: { cancellable: false, early_completion_available: false },
  links: { ...baseJob().links, schedule: "/optimize/opt_1/xlsx" },
});

// Readiness through the product's own write path (the unit test's `readyStore`).
const READY: Partial<ScenarioUiState> = {
  staff: [{ id: "p1" }],
  shifts: [{ id: "early1" }],
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-14",
};

// Longest prefixes first: the router takes the first match.
const runRoutes = (job: JobResponse) =>
  withFetchRoutes([
    ["/api/optimize/opt_1/events", () => sseResponse(": keepalive\n\n")],
    ["/api/optimize/opt_1", () => jsonResponse(200, job)],
    [
      "/api/optimize",
      (_path, init) =>
        init?.method === "POST" ? jsonResponse(202, baseJob()) : jsonResponse(405, {}),
    ],
  ]);

const saveBlob = fn();
const deleteJob = fn(async () => ({ status: "confirmed" as const }));
const fetchXlsx = fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));

const meta = {
  title: "Optimize/OptimizeAndExportScreen",
  component: OptimizeAndExportScreen,
  parameters: {
    scenario: READY,
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/optimize-and-export" } },
  },
  beforeEach: () => {
    resetRosterCaptureGate();
    useHotStore.getState().resetRunView();
    values.clear();
    sessionStorage.removeItem(OPTIMIZE_SESSION_STORAGE_KEY);
    for (const spy of [saveBlob, deleteJob, fetchXlsx]) spy.mockClear();
  },
  args: {
    serverInfoDeps: info(),
    controllerDeps: {
      prepare: () => okPrep,
      stageSnapshot: degradedCapture,
      storage,
      createOwnerId: () => "owner-1",
    },
    terminalDeps: { saveBlob, deleteJob, fetchXlsx },
  },
} satisfies Meta<typeof OptimizeAndExportScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotReady: Story = {
  parameters: { scenario: "empty" },
  beforeEach: withFetchRoutes([]),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Online")).toBeVisible();
    await expect(canvas.getByTestId("optimize-submit")).toBeDisabled();
    await expect(canvas.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Complete the missing schedule configuration before optimising.",
    );
  },
};

export const Offline: Story = {
  args: { serverInfoDeps: info({ status: 502 }) },
  beforeEach: withFetchRoutes([]),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Offline")).toBeVisible();
    await expect(canvas.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Backend unavailable.",
    );
    await expect(canvas.getByTestId("optimize-submit")).toBeDisabled();
    await expect(canvas.queryByTestId("optimize-start")).toBeNull();
  },
};

export const VersionMismatch: Story = {
  args: { serverInfoDeps: info({ clientVersion: "9.9.9" }) },
  beforeEach: withFetchRoutes([]),
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("optimize-version-mismatch")).toBeVisible();
  },
};

export const Ready: Story = {
  beforeEach: withFetchRoutes([]),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByTestId("optimize-submit")).toBeEnabled());
    await expect(canvas.getByTestId("optimize-start")).toBeVisible();
    await expect(canvas.getByTestId("optimize-server-bar")).toHaveTextContent("1.0.0");
  },
};

export const SubmitSuccess: Story = {
  beforeEach: runRoutes(completedJob),
  play: async ({ canvas, userEvent }) => {
    await waitFor(() => expect(canvas.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(canvas.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(canvas.getByTestId("optimize-completed-artifact")).toHaveTextContent(
        "Schedule optimised and downloaded successfully!",
      ),
    );
    await expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "schedule.xlsx");
    await expect(deleteJob).toHaveBeenCalledWith("opt_1");
  },
};

export const Queued: Story = {
  beforeEach: runRoutes(baseJob()),
  play: async ({ canvas, userEvent }) => {
    await waitFor(() => expect(canvas.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(canvas.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(canvas.getByTestId("optimize-status")).toHaveTextContent("Queued, position 2"),
    );
  },
};

// The run record cannot be staged, so the POST never happens (the router has no routes).
export const StartFailed: Story = {
  args: {
    controllerDeps: {
      prepare: () => okPrep,
      stageSnapshot: degradedCapture,
      storage: occupiedStorage,
      createOwnerId: () => "owner-1",
    },
  },
  beforeEach: withFetchRoutes([]),
  play: async ({ canvas, userEvent }) => {
    await waitFor(() => expect(canvas.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(canvas.getByTestId("optimize-submit"));
    await expect(await canvas.findByTestId("optimize-start-failed")).toBeVisible();
    await expect(saveBlob).not.toHaveBeenCalled();
  },
};

export const Dark: Story = {
  beforeEach: withFetchRoutes([]),
  globals: { theme: "dark" },
};
