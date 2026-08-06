// Global vitest setup (T17b-2). Registers the jest-dom matchers (`toBeInTheDocument`,
// `toHaveTextContent`, ...) for the `.tsx` component suite; a no-op import for the
// plain `.ts` unit suite (node environment, no DOM to extend).
import "@testing-library/jest-dom/vitest";

// The transactional scenario repository (T02) is the durable authority for every
// scenario mutation after the T03 cutover, so essentially the whole suite now
// touches IndexedDB. Registering the in-memory implementation globally is what
// lets an ordinary editor test drive the REAL repository transaction rather than
// a mock of it — which is the only way a test can prove "one mutation, one
// durable commit".
import "fake-indexeddb/auto";
