import localFont from "next/font/local";

// Design-system fonts (docs/design_prototype/README.md): Hanken Grotesk drives
// body/UI, Figtree drives display/headings, Spline Sans Mono drives codes/data.
// Each is exposed as a CSS variable consumed by the --ff-* stacks in globals.css.
//
// Self-hosted via next/font/local from the @fontsource-variable/* packages
// (bd nursing-sheduler-q94): next/font/google fetches from fonts.googleapis.com /
// fonts.gstatic.com at build time, which fails the build when that host is
// unreachable (happened twice on deploy server tc1). Each @fontsource-variable
// package ships one latin-subset variable woff2 (wght axis) plus its own
// OFL-1.1 LICENSE, so a single file covers the whole weight range that was
// previously requested as discrete static weights from Google Fonts.
//
// In their own module (bead w0e.2) so the Storybook preview loads the SAME faces.
const figtree = localFont({
  src: "../node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  variable: "--font-figtree",
  weight: "500 900",
  display: "swap",
});

const hankenGrotesk = localFont({
  src: "../node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
  variable: "--font-hanken",
  weight: "400 700",
  display: "swap",
});

const splineSansMono = localFont({
  src: "../node_modules/@fontsource-variable/spline-sans-mono/files/spline-sans-mono-latin-wght-normal.woff2",
  variable: "--font-spline-mono",
  weight: "400 700",
  display: "swap",
});

/**
 * The three variable classes. They must sit on `<html>`: globals.css resolves the
 * `--ff-*` stacks at `:root`, so a class on a descendant would not reach them.
 */
export const fontClassName = `${figtree.variable} ${hankenGrotesk.variable} ${splineSansMono.variable}`;
