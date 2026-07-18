// Global vitest setup (T17b-2). Registers the jest-dom matchers (`toBeInTheDocument`,
// `toHaveTextContent`, ...) for the `.tsx` component suite; a no-op import for the
// plain `.ts` unit suite (node environment, no DOM to extend).
import "@testing-library/jest-dom/vitest";
