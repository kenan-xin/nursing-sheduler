import type { Preview } from "@storybook/nextjs-vite";
import { fontClassName } from "../app/fonts";
import "../app/globals.css";
import { withQueryClient, withResetTransientStores, withTheme } from "./harness";

// Same <html> classes as app/layout.tsx: globals.css resolves --ff-* from them at :root.
document.documentElement.classList.add(...fontClassName.split(" "), "antialiased");

const preview: Preview = {
  parameters: {
    layout: "centered",
    // Epic acceptance: a11y violations FAIL the story test, they do not warn.
    a11y: { test: "error" },
  },
  globalTypes: {
    theme: {
      description: "Light or dark theme",
      toolbar: { title: "Theme", items: ["light", "dark"], dynamicTitle: true },
    },
    accent: {
      description: "Accent colour (DESIGN.md v2 accent set)",
      toolbar: { title: "Accent", items: ["teal", "sage", "rose", "plum"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "light", accent: "teal" },
  decorators: [withQueryClient, withTheme],
  beforeEach: withResetTransientStores,
};

export default preview;
