import type { Metadata } from "next";
import { Figtree, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
// The locked CopilotKit v2 chat primitives' ONE compiled stylesheet, and the only
// place it is imported.
//
// WHY IT HAS TO BE HERE. `@copilotkit/react-core@1.66.2` does import `./index.css`
// from its own `dist/v2/index.mjs`, but Next does not process a stylesheet imported
// from inside an untranspiled node_modules package: a production build of this app
// with the assistant mounted emitted ZERO `[data-copilotkit]` rules. Every layout
// class in the library's markup (`cpk:flex`, `cpk:overflow-y-auto`, `cpk:absolute`)
// is defined only in that file, so without this line the transcript is unbounded,
// the composer's three-column grid collapses into three stacked rows below the
// dock, and the message bubbles have neither fill nor radius.
//
// BEFORE `./globals.css`, deliberately: globals.css re-points the library's own
// scoped theme at this system's tokens, and a later sheet is the simplest way for
// those to win. It is not the ONLY way -- the override selectors there are also
// specificity-qualified -- but a silent flip would repaint the assistant in shadcn
// greys.
//
// WHAT GUARDS WHAT, stated exactly, because an earlier version of this comment
// claimed more than is true:
//
//   * that this is the ONLY import of the sheet -- Oxlint. The specifier is closed
//     repository-wide and exempted at this file alone (`copilotkit-stylesheet-entry`),
//     so a second CSS entry is unavailable rather than merely unspelled.
//   * that the sheet is actually SHIPPED AND ACTIVE -- the production-build browser
//     suite `e2e/ai-assistant-chat-ui.spec.ts`. Deleting this line fails it causally.
//     That is the stronger proof: the defect this line exists for was an import that
//     was PRESENT and not processed, which any source-text check would have passed.
//   * the ORDER relative to `./globals.css` is NOT asserted anywhere as a spelling.
//     Only its rendered consequence is measured, by the same browser suite.
//
// `components/ai/assistant-styles.test.ts` proves the sheet's SCOPING from the
// installed package bytes. It does not read this file, and does not check that this
// import exists or where it sits.
import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";
import { Providers } from "./providers";
import { ThemeScript } from "@/components/theme/theme-script";

// Design-system fonts (docs/design_prototype/README.md): Hanken Grotesk drives
// body/UI, Figtree drives display/headings, Spline Sans Mono drives codes/data.
// Each is exposed as a CSS variable consumed by the --ff-* stacks in globals.css.
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
  display: "swap",
});

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const splineSansMono = Spline_Sans_Mono({
  variable: "--font-spline-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nurse Scheduler",
  description: "Nurse scheduling application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${figtree.variable} ${hankenGrotesk.variable} ${splineSansMono.variable} h-full antialiased`}
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
