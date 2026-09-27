import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn } from "storybook/test";
import type { RosterCaptureState } from "@/lib/optimize";
import { CaptureNotice } from "./capture-notice";

const COMMITTED: RosterCaptureState = {
  status: "committed",
  pointer: { jobId: "opt_1", candidateVersion: 1, submissionOrdinal: 1 },
  working: { kind: "awaiting-choice", reason: "working-present" },
};

const meta = {
  title: "Optimize/CaptureNotice",
  component: CaptureNotice,
  parameters: { layout: "padded" },
  args: { state: COMMITTED, onRetry: fn(), onDismiss: fn(), dismissPending: false },
} satisfies Meta<typeof CaptureNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Committed: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("optimize-capture-committed")).toBeVisible();
    await userEvent.click(canvas.getByTestId("optimize-capture-dismiss"));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const FetchFailed: Story = {
  args: {
    state: { status: "fetch-failed", message: "network down", jobGone: false, retryable: true },
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("optimize-capture-fetch-failed")).toBeVisible();
    await userEvent.click(canvas.getByTestId("optimize-capture-retry"));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const FetchFailedJobGone: Story = {
  args: {
    state: { status: "fetch-failed", message: "gone", jobGone: true, retryable: false },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-fetch-failed")).toHaveTextContent(
      /no longer available on the server/i,
    );
    // A pruned job can never be refetched, so no Retry is offered.
    await expect(canvas.queryByTestId("optimize-capture-retry")).toBeNull();
  },
};

export const FetchFailedUnsupported: Story = {
  args: {
    state: {
      status: "fetch-failed",
      message:
        "The scheduling service this app is connected to does not support saving rosters, so it needs to be updated before rosters can be saved here.",
      jobGone: false,
      retryable: false,
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-fetch-failed")).toHaveTextContent(
      /does not support saving rosters/i,
    );
    await expect(canvas.queryByTestId("optimize-capture-retry")).toBeNull();
  },
};

export const CommitFailed: Story = {
  args: { state: { status: "commit-failed", message: "quota exceeded" } },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("optimize-capture-retry"));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const StorageUnavailable: Story = {
  args: { state: { status: "unavailable", cause: "snapshot_persist_failed" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-storage-unavailable")).toBeVisible();
    await expect(canvas.queryByTestId("optimize-capture-retry")).toBeNull();
  },
};

export const SubmissionMissing: Story = {
  args: { state: { status: "unavailable", cause: "snapshot_missing" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-submission-missing")).toBeVisible();
  },
};

export const RecordAbsent: Story = {
  args: { state: { status: "unavailable", cause: "session_record_absent" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-record-absent")).toBeVisible();
  },
};

export const AssemblyRejected: Story = {
  args: { state: { status: "unavailable", cause: "assembly-rejected" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-capture-assembly-rejected")).toBeVisible();
  },
};

export const DismissFailed: Story = {
  args: { state: { status: "dismiss-failed", message: "storage unavailable" } },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("optimize-capture-dismiss"));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const DismissPending: Story = {
  args: { dismissPending: true },
  play: async ({ args, canvas }) => {
    const dismiss = canvas.getByTestId("optimize-capture-dismiss");
    await expect(dismiss).toBeDisabled();
    // `userEvent` refuses a disabled control (`pointer-events: none`), so dispatch the
    // click directly: the point is that the handler still does not fire.
    fireEvent.click(dismiss);
    await expect(args.onDismiss).not.toHaveBeenCalled();
  },
};

export const Dark: Story = {
  args: { ...FetchFailed.args },
  globals: { theme: "dark" },
};
