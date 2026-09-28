import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import { FaPen, FaTrash } from "@/components/icons";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import {
  CardActionButton,
  CardEditorEmptyState,
  CardEditorForm,
  CardEditorHardRuleNote,
  CardEditorHeader,
  CardEditorInstructions,
  CardEditorScreen,
  CardListHeading,
  CardListItem,
  CardMoveActions,
} from "./card-editor-shell";

// One file for the shell module's parts, composed the way the five card editors mount them.
const HEADER = {
  eyebrow: "CONSTRAINT · TEST",
  title: "Staffing Requirements",
  subtitle: "How many people each shift needs.",
  addLabel: "Add Requirement",
};

const CARDS = [{ uid: "a" }, { uid: "b" }];

interface ShellArgs {
  onAdd: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReorder: (from: string, to: string, position: "before" | "after") => void;
}

const meta = {
  title: "CardEditor/CardEditorShell",
  parameters: { layout: "padded" },
  args: {
    onAdd: fn(),
    onSubmit: fn(),
    onCancel: fn(),
    onEdit: fn(),
    onDelete: fn(),
    onReorder: fn(),
  },
  render: (args) => (
    <CardEditorScreen screen="Requirements">
      <CardEditorHeader {...HEADER} formOpen={false} onAdd={args.onAdd} />
      <CardEditorEmptyState
        title="No staffing requirements yet."
        addLabel="Add Requirement"
        onAdd={args.onAdd}
      />
    </CardEditorScreen>
  ),
} satisfies Meta<ShellArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

const listItem = (args: ShellArgs, value: string) => (
  <>
    <CardListHeading title="Requirements" count={2} />
    {/* CardListItem is an <li>; the editors mount it inside their card <ul>. */}
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      <CardListItem
        index={0}
        testId="card-0"
        changeKey="story:card-0"
        title="Day cover"
        fields={[
          { label: "Shift", value },
          { label: "People", value: "2" },
        ]}
        actions={
          <>
            <CardMoveActions
              cards={CARDS}
              index={0}
              onReorder={args.onReorder}
              testIdPrefix="req"
              subject="requirement"
            />
            <CardActionButton icon={<FaPen />} onClick={args.onEdit} testId="req-edit-0">
              Edit
            </CardActionButton>
            <CardActionButton
              icon={<FaTrash />}
              danger
              onClick={args.onDelete}
              testId="req-delete-0"
            >
              Delete
            </CardActionButton>
            <CardActionButton
              icon={<FaPen />}
              onClick={args.onEdit}
              testId="req-convert-0"
              disabled
              disabledReason="Edit this card in YAML"
            >
              Convert
            </CardActionButton>
          </>
        }
      />
    </ul>
  </>
);

export const Empty: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("card-editor-empty")).toHaveTextContent(
      "No staffing requirements yet.",
    );
    await userEvent.click(
      within(canvas.getByTestId("card-editor-empty")).getByRole("button", { name: /Add/ }),
    );
    await expect(args.onAdd).toHaveBeenCalledOnce();
  },
};

export const FormOpen: Story = {
  render: (args) => (
    <CardEditorScreen screen="Requirements">
      <CardEditorHeader {...HEADER} formOpen onAdd={args.onAdd} />
      <CardEditorForm
        heading="Add requirement"
        submitLabel="Add"
        onSubmit={args.onSubmit}
        onCancel={args.onCancel}
      >
        <p>Form body</p>
      </CardEditorForm>
    </CardEditorScreen>
  ),
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("add-card-toggle")).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(canvas.getByTestId("add-card-toggle"));
    await expect(args.onAdd).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSubmit).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

export const Instructions: Story = {
  render: (args) => (
    <CardEditorHeader
      {...HEADER}
      formOpen={false}
      onAdd={args.onAdd}
      instructions={<CardEditorInstructions items={["Pick a shift.", "Set a head count."]} />}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    const toggle = canvas.getByTestId("card-editor-help-toggle");
    await expect(canvas.queryByTestId("card-editor-instructions")).toBeNull();
    await userEvent.click(toggle);
    await expect(canvas.getByTestId("card-editor-instructions")).toHaveTextContent(
      "Set a head count.",
    );
    await userEvent.click(toggle);
    await expect(canvas.queryByTestId("card-editor-instructions")).toBeNull();
  },
};

export const HardRuleNote: Story = {
  render: () => (
    <CardEditorHardRuleNote>Coverings are hard rules and carry no weight.</CardEditorHardRuleNote>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-editor-hard-note")).toBeVisible();
  },
};

export const ListItem: Story = {
  render: (args) => listItem(args, "late+"),
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByTestId("req-up-0")).toBeDisabled();
    await userEvent.click(canvas.getByTestId("req-down-0"));
    await expect(args.onReorder).toHaveBeenCalledWith("a", "b", "after");
    await userEvent.click(canvas.getByTestId("req-edit-0"));
    await expect(args.onEdit).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("req-delete-0"));
    await expect(args.onDelete).toHaveBeenCalledOnce();
    await expect(canvas.getByTestId("req-convert-0-reason")).toHaveTextContent(
      "Edit this card in YAML",
    );
  },
};

export const LongText: Story = {
  render: (args) => listItem(args, LONG_TOKEN),
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    const value = canvas.getByTitle(LONG_TOKEN);
    await expect(value.scrollWidth).toBeGreaterThan(value.clientWidth);
  },
};

export const Dark: Story = {
  render: (args) => listItem(args, "late+"),
  globals: { theme: "dark" },
};
