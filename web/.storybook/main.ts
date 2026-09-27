import type { StorybookConfig } from "@storybook/nextjs-vite";

// Storybook workbench (bead w0e). The nextjs-vite framework mocks next/navigation,
// next/image and next/font, and reads postcss.config.mjs for Tailwind v4.
const config: StorybookConfig = {
  stories: ["./*.stories.tsx", "../components/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: "@storybook/nextjs-vite",
};

export default config;
