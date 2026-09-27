import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Surface } from "./surface";

// One story per LEGAL `SurfaceVisualProps` pair plus one per `SurfaceEmphasis`
// member. `SurfaceProps` is a discriminated union, which makes Storybook require
// `args` on every story; each story therefore declares its own tuple and spreads
// it, so the args and the rendered element cannot drift apart.
//
// The `className` here is layout-only by contract (see `surface-consumer-classname`),
// and `Surface` stamps `data-level` / `data-geometry` / `data-emphasis` itself, so
// the assertions read those rather than a test-only attribute.
const meta = {
  title: "UI/Surface",
  component: Surface,
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectSurface(
  canvasElement: HTMLElement,
  level: string,
  geometry: string,
): Promise<void> {
  const el = canvasElement.querySelector<HTMLElement>('[data-slot="surface"]');
  await expect(el).toHaveAttribute("data-level", level);
  await expect(el).toHaveAttribute("data-geometry", geometry);
}

export const PageSquare: Story = {
  args: { level: "page", geometry: "square" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="h-20 p-4">
        <span className="text-meta text-ink2">L0 app plane</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "page", "square"),
};

export const SurfaceCard: Story = {
  args: { level: "surface", geometry: "card" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">L1 card</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "surface", "card"),
};

export const SurfaceSquare: Story = {
  args: { level: "surface", geometry: "square" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">L1 full-bleed band</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "surface", "square"),
};

export const RaisedCard: Story = {
  args: { level: "raised", geometry: "card" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">L2 dialog plane</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "raised", "card"),
};

export const WellControl: Story = {
  args: { level: "well", geometry: "control" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">Inset island at the control radius</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "well", "control"),
};

export const WellChip: Story = {
  args: { level: "well", geometry: "chip" },
  render: (args) => (
    <Surface {...args} className="inline-flex px-3 py-1">
      <span className="text-meta text-ink2">Summary chip</span>
    </Surface>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "well", "chip"),
};

export const WellSquare: Story = {
  args: { level: "well", geometry: "square" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">Inset band</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => expectSurface(canvasElement, "well", "square"),
};

export const WellHairline: Story = {
  args: { level: "well", geometry: "control", emphasis: "hairline" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">Recessed row with a --line2 edge</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expectSurface(canvasElement, "well", "control");
    await expect(canvasElement.querySelector('[data-slot="surface"]')).toHaveAttribute(
      "data-emphasis",
      "hairline",
    );
  },
};

export const WellDropCandidate: Story = {
  args: { level: "well", geometry: "control", emphasis: "drop-candidate" },
  render: (args) => (
    <div className="w-80">
      <Surface {...args} className="p-4">
        <span className="text-meta text-ink2">Row under the pointer</span>
      </Surface>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expectSurface(canvasElement, "well", "control");
    await expect(canvasElement.querySelector('[data-slot="surface"]')).toHaveAttribute(
      "data-emphasis",
      "drop-candidate",
    );
  },
};

// DESIGN.md §4: the ladder is expressed by tone first, shadow second. The args
// satisfy the union-typed meta; the ladder authors its own three levels literally.
function LadderDemo() {
  return (
    <div className="w-80">
      <Surface level="page" geometry="square" className="p-4">
        <Surface level="surface" geometry="card" className="p-4">
          <Surface level="well" geometry="control" className="p-4">
            <span className="text-meta text-ink2">Page, surface, well</span>
          </Surface>
        </Surface>
      </Surface>
    </div>
  );
}

export const Ladder: Story = {
  args: { level: "page", geometry: "square" },
  render: () => <LadderDemo />,
  play: async ({ canvasElement }) => {
    const page = canvasElement.querySelector<HTMLElement>('[data-level="page"]');
    const surface = page?.querySelector<HTMLElement>('[data-level="surface"]');
    const well = surface?.querySelector<HTMLElement>('[data-level="well"]');
    // Nesting is the claim: page ⊃ surface ⊃ well, never the same tone twice.
    await expect(well).toHaveAttribute("data-geometry", "control");
    await expect(well).toHaveAttribute("data-level", "well");
  },
};

export const Dark: Story = {
  args: { level: "page", geometry: "square" },
  render: () => <LadderDemo />,
  globals: { theme: "dark" },
};
