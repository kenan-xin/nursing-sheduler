import type { StorybookConfig } from "@storybook/nextjs-vite";

// Storybook workbench (bead w0e). The nextjs-vite framework mocks next/navigation,
// next/image and next/font, and reads postcss.config.mjs for Tailwind v4.
const config: StorybookConfig = {
  stories: ["./Introduction.mdx", "./*.stories.tsx", "../components/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: "@storybook/nextjs-vite",
  // Pre-bundled up front: discovered mid-run on a cold cache, Vite reloads and the
  // story tests in flight fail.
  viteFinal: (config) => ({
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      include: [
        ...(config.optimizeDeps?.include ?? []),
        "@tanstack/react-virtual",
        "@copilotkit/react-core/v2",
      ],
    },
  }),
};

export default config;
