import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/components/shell/nav-config";
import { CAPABILITY_ANCHOR_ATTRIBUTE, capabilityAnchorSelector } from "./anchor-contract";
import { CONTROL_ANCHOR_DECLARATIONS, findControlAnchor } from "./anchors";

const COMPONENTS_DIR = fileURLToPath(new URL("../../components", import.meta.url));
const MANIFEST_SOURCE = readFileSync(
  fileURLToPath(new URL("./anchors.ts", import.meta.url)),
  "utf8",
);

/** Every `components/<owner>/capability-anchors.ts` actually on disk. */
function ownerAnchorModules(): { owner: string; dir: string }[] {
  return readdirSync(COMPONENTS_DIR)
    .map((entry) => ({ owner: entry, dir: join(COMPONENTS_DIR, entry) }))
    .filter((candidate) => {
      if (!statSync(candidate.dir).isDirectory()) return false;
      return readdirSync(candidate.dir).includes("capability-anchors.ts");
    });
}

describe("control-anchor manifest", () => {
  it("collects every owner-local declaration module on disk", () => {
    // The failure this prevents: declaring and rendering an anchor, forgetting the
    // import here, and shipping a control the registry cannot address. Nothing else
    // would notice — the entry would simply never reference it.
    for (const { owner } of ownerAnchorModules()) {
      expect(
        MANIFEST_SOURCE.includes(`@/components/${owner}/capability-anchors`),
        `components/${owner}/capability-anchors.ts is not imported by anchors.ts`,
      ).toBe(true);
    }
  });

  it("every declared anchor is rendered by a component in its owner directory", () => {
    // The source-level half of the missing/renamed-anchor gate. The browser fixture
    // proves the attribute reaches the DOM; this proves the constant is referenced at
    // all, so a declaration that nothing renders fails here rather than at deploy.
    for (const { owner, dir } of ownerAnchorModules()) {
      const declarationSource = readFileSync(join(dir, "capability-anchors.ts"), "utf8");
      const exportedConstants = [...declarationSource.matchAll(/export const (\w+_ANCHOR)\b/g)].map(
        (match) => match[1],
      );
      expect(
        exportedConstants.length,
        `components/${owner} exports no anchor constant`,
      ).toBeGreaterThan(0);

      const rendered = readdirSync(dir)
        .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("\n");
      for (const constant of exportedConstants) {
        expect(
          rendered.includes(constant),
          `components/${owner} declares ${constant} but no component in that directory renders it`,
        ).toBe(true);
      }
    }
  });

  it("anchor ids are unique", () => {
    const ids = CONTROL_ANCHOR_DECLARATIONS.map((anchor) => anchor.anchorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every anchor names a real route", () => {
    const routeIds = new Set(ALL_NAV_ITEMS.map((item) => item.id));
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(routeIds.has(anchor.routeId), `anchor "${anchor.anchorId}"`).toBe(true);
    }
  });

  it("declarations and the manifest are frozen", () => {
    // The manifest is shipped state that a help answer is grounded in; a spec (or a
    // component) that could mutate it in place could retarget an answer at runtime.
    expect(Object.isFrozen(CONTROL_ANCHOR_DECLARATIONS)).toBe(true);
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(Object.isFrozen(anchor)).toBe(true);
    }
  });

  it("ids stay safe inside an attribute selector", () => {
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(anchor.anchorId).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
      expect(capabilityAnchorSelector(anchor.anchorId)).toBe(
        `[${CAPABILITY_ANCHOR_ATTRIBUTE}="${anchor.anchorId}"]`,
      );
    }
  });

  it("lookup misses return undefined rather than a nearby anchor", () => {
    expect(findControlAnchor("dates.roster-period-renamed")).toBeUndefined();
  });
});
