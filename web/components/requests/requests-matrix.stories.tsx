import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import type { UiPerson, UiRequestCell } from "@/lib/scenario";
import { LONG_TOKEN } from "../../.storybook/story-helpers";
import { RequestsMatrix } from "./requests-matrix";
import {
  historyColumnCount,
  historyColumnLabels,
  type RequestColumn,
  type RequestRow,
} from "./requests-model";

// Fixtures mirror requests-matrix.test.tsx.
const PEOPLE: UiPerson[] = [{ id: "Alice", history: ["N12", "OFF"] }, { id: "Bob" }];

const ROWS: RequestRow[] = [
  { isGroup: true, id: "NightOwls", label: "NightOwls", members: ["Alice", "Bob"] },
  { isGroup: false, id: "Alice", label: "1. Alice", personIndex: 1 },
  { isGroup: false, id: "Bob", label: "2. Bob", personIndex: 2 },
];

const COLUMNS: RequestColumn[] = [
  { kind: "date-group", ref: "ALL", label: "ALL", synthetic: true, count: 2 },
  { kind: "date-item", ref: "2026-07-03", iso: "2026-07-03", label: "07/03", weekend: false },
  { kind: "date-item", ref: "2026-07-04", iso: "2026-07-04", label: "07/04", weekend: true },
];

const REQ_DATA: UiRequestCell[] = [
  { kind: "request", person: "Alice", date: "2026-07-03", shiftType: "late+", weight: 5 },
  { kind: "leave", person: "Bob", date: "2026-07-03" },
  { kind: "off", person: "Alice", date: "ALL", weight: -3 },
];

const historyCount = historyColumnCount(PEOPLE);

function many(n: number) {
  const people: UiPerson[] = Array.from({ length: n }, (_, i) => ({ id: `P${i + 1}` }));
  const rows: RequestRow[] = people.map((p, i) => ({
    isGroup: false,
    id: p.id,
    label: `${i + 1}. ${p.id}`,
    personIndex: i + 1,
  }));
  return { people, rows, historyCount: historyColumnCount(people) };
}

const meta = {
  title: "Requests/RequestsMatrix",
  component: RequestsMatrix,
  parameters: { layout: "padded" },
  // The matrix virtualises its rows, so it renders none without a sized box.
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[960px]">
        <Story />
      </div>
    ),
  ],
  args: {
    rows: ROWS,
    columns: COLUMNS,
    people: PEOPLE,
    historyCount,
    historyLabels: historyColumnLabels(historyCount),
    reqData: REQ_DATA,
    shiftTypeOrderIndex: () => 0,
    mode: "normal",
    onCellClick: fn(),
    onHistoryClick: fn(),
    onCellPointerDown: fn(),
    onCellPointerEnter: fn(),
    onHistoryPointerDown: fn(),
    onHistoryPointerEnter: fn(),
  },
} satisfies Meta<typeof RequestsMatrix>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requests-matrix-empty")).toBeVisible();
  },
};

export const Normal: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const cell = await canvas.findByTestId("cell-Alice-2026-07-03");
    await expect(canvas.getByTestId("cell-Bob-2026-07-03")).toHaveTextContent("Leave");
    await userEvent.click(cell);
    await expect(args.onCellClick).toHaveBeenCalledOnce();
    await expect(args.onCellClick).toHaveBeenCalledWith("Alice", "2026-07-03", cell);
    const hist = canvas.getByTestId("hist-Alice-1");
    await expect(hist).toHaveTextContent("N12");
    await userEvent.click(hist);
    await expect(args.onHistoryClick).toHaveBeenCalledOnce();
    await expect(args.onHistoryClick).toHaveBeenCalledWith("Alice", 1, hist);
  },
};

export const Quick: Story = {
  args: { mode: "quick", stagedKeys: new Set([JSON.stringify(["Alice", "2026-07-04"])]) },
  play: async ({ args, canvas, userEvent }) => {
    await expect(await canvas.findByTestId("cell-Alice-2026-07-04")).toHaveClass("outline-brand");
    await userEvent.pointer({
      keys: "[MouseLeft>]",
      target: canvas.getByTestId("cell-Bob-2026-07-04"),
    });
    await expect(args.onCellPointerDown).toHaveBeenCalledWith("Bob", "2026-07-04");
    await userEvent.pointer({ keys: "[/MouseLeft]" });
    await expect(args.onCellClick).not.toHaveBeenCalled();
  },
};

// Alice's ALL off-request reaches both her date cells; a NightOwls request reaches Bob's 07/04.
export const GroupSources: Story = {
  args: {
    groupSources: new Map([
      [JSON.stringify(["Alice", "2026-07-03"]), { sources: ["From ALL · OFF -3"], short: "OFF" }],
      [JSON.stringify(["Alice", "2026-07-04"]), { sources: ["From ALL · OFF -3"], short: "OFF" }],
      [
        JSON.stringify(["Bob", "2026-07-04"]),
        { sources: ["From NightOwls · late+ +5"], short: "late+" },
      ],
    ]),
  },
  play: async ({ canvas }) => {
    const bob = await canvas.findByTestId("cell-Bob-2026-07-04");
    await expect(bob).toHaveTextContent("late+");
    await expect(bob).toHaveAttribute("title", "From NightOwls · late+ +5");
    await expect(bob).toHaveAccessibleName(/; From NightOwls · late\+ \+5$/);
    // A direct request keeps its own text; the marker only adds the glyph.
    await expect(canvas.getByTestId("cell-Alice-2026-07-03")).toHaveTextContent("late+ (+5)");
    await expect(canvas.getByTestId("group-source-Alice-2026-07-03")).toBeInTheDocument();
  },
};

export const WithHistory: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("hist-head-0")).toHaveTextContent("H-3");
    await expect(canvas.getByTestId("hist-Alice-2")).toHaveTextContent("OFF");
    await expect(canvas.getByTestId("hist-NightOwls-1")).toHaveTextContent("—");
  },
};

// Proves virtualisation in real Chromium: the last row mounts only once scrolled to.
const SIXTY = many(60);
export const ManyRows: Story = {
  args: {
    ...SIXTY,
    historyLabels: historyColumnLabels(SIXTY.historyCount),
    reqData: [],
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("row-P1")).toBeVisible();
    await expect(canvas.queryByTestId("row-P60")).toBeNull();
    const scroller = canvas.getByTestId("requests-matrix");
    scroller.scrollTop = scroller.scrollHeight;
    await waitFor(() => expect(canvas.getByTestId("row-P60")).toBeInTheDocument());
  },
};

export const LongText: Story = {
  args: {
    rows: [
      {
        isGroup: false,
        id: "Alice",
        label: `1. ${LONG_TOKEN}`,
        personIndex: 1,
        description: LONG_TOKEN,
      },
    ],
  },
  play: async ({ canvas }) => {
    const row = await canvas.findByTestId("row-Alice");
    const header = row.firstElementChild as HTMLElement;
    await expect(header).toHaveAttribute("title", LONG_TOKEN);
    const label = header.querySelector("span")!;
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};

// t4tz: low-weight cells sit at the α floor, (+N) counts ride on leave/off tints and
// Bob's empty history slot shows the "+" affordance. Cells are forced `relative`
// because axe only resolved (and so only flagged) the old opacity fade on a
// positioned cell; an unresolved ("incomplete") check fails here too.
const FADED: Story = {
  args: {
    reqData: [
      { kind: "request", person: "Alice", date: "2026-07-03", shiftType: "late+", weight: 1 },
      { kind: "request", person: "Alice", date: "2026-07-04", shiftType: "early", weight: -2 },
      { kind: "request", person: "Alice", date: "ALL", shiftType: "early", weight: 3 },
      { kind: "request", person: "Alice", date: "ALL", shiftType: "late+", weight: -3 },
      { kind: "leave", person: "Bob", date: "2026-07-03" },
      { kind: "request", person: "Bob", date: "2026-07-03", shiftType: "late+", weight: 1 },
      { kind: "off", person: "Bob", date: "2026-07-04", weight: -1 },
      { kind: "request", person: "Bob", date: "2026-07-04", shiftType: "early", weight: 1 },
    ],
    groupSources: new Map([
      [
        JSON.stringify(["Alice", "2026-07-03"]),
        { sources: ["From NightOwls · late+ +1"], short: "late+" },
      ],
    ]),
  },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByTestId("cell-Alice-2026-07-03");
    await expect(canvas.getByTestId("cell-Bob-2026-07-03")).toHaveTextContent("Leave (+1)");
    await expect(canvas.getByTestId(`hist-Bob-${historyCount - 1}`)).toHaveTextContent("+");
    for (const cell of canvasElement.querySelectorAll<HTMLElement>("[data-testid^='cell-']")) {
      cell.style.position = "relative";
    }
    const { default: axe } = await import("axe-core");
    const results = await axe.run(canvas.getByTestId("requests-matrix"), {
      runOnly: ["color-contrast"],
    });
    await expect(results.violations.flatMap((v) => v.nodes.map((n) => n.target))).toEqual([]);
    await expect(results.incomplete.flatMap((v) => v.nodes.map((n) => n.target))).toEqual([]);
  },
};

export const FadedContrast: Story = FADED;

export const FadedContrastDark: Story = { ...FADED, globals: { theme: "dark" } };
