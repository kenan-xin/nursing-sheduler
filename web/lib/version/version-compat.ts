/**
 * Shared version-compatibility classifier.
 *
 * Parses `git describe --tags --always --dirty` output and classifies the
 * relationship between two version strings into one of six tiers. Both the
 * runtime frontend↔backend banner (surface a) and the saved-YAML load check
 * (surface b) consume this util so they judge compatibility identically.
 *
 * Grammar: `[v]MAJOR.MINOR.PATCH[-N-gHASH][-dirty]` or a bare hash.
 * The leading `v` is optional (decision B): `0.1.0` and `v0.1.0` parse to the
 * same semver, so legacy YAML stamped without the prefix stays comparable.
 */

export type VersionParts = {
  major: number | null;
  minor: number | null;
  patch: number | null;
  commitsAfterTag: number;
  commitId: string | null;
  dirty: boolean;
  full: string;
};

export type CompatibilityTier =
  | "identical"
  | "compatible"
  | "incompatible"
  | "indeterminate"
  | "dirty"
  | "missing";

const HASH_ONLY_PATTERN = /^[0-9a-fA-F]{7,}$/;
const TAGGED_COMMIT_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-fA-F]{7,})$/;
const TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

const SENTINEL_VALUES = new Set(["", "unknown", "v0.0.0-unknown"]);

function normalizeInput(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (SENTINEL_VALUES.has(trimmed)) return undefined;
  return trimmed;
}

/**
 * Whether a version string carries identifiable version info — i.e. it is not
 * absent, blank, or one of the unknown sentinels. Shares the classifier's own
 * sentinel/normalization logic so callers never hardcode the sentinel strings.
 */
export function isIdentifiableVersion(raw: string | null | undefined): boolean {
  return normalizeInput(raw) !== undefined;
}

export function parseVersionParts(version: string): VersionParts {
  const isDirty = version.endsWith("-dirty");
  const cleanVersion = isDirty ? version.slice(0, -"-dirty".length) : version;

  if (HASH_ONLY_PATTERN.test(cleanVersion)) {
    return {
      major: null,
      minor: null,
      patch: null,
      commitsAfterTag: 0,
      commitId: cleanVersion,
      dirty: isDirty,
      full: version,
    };
  }

  const taggedCommitMatch = cleanVersion.match(TAGGED_COMMIT_PATTERN);
  if (taggedCommitMatch) {
    return {
      major: parseInt(taggedCommitMatch[1], 10),
      minor: parseInt(taggedCommitMatch[2], 10),
      patch: parseInt(taggedCommitMatch[3], 10),
      commitsAfterTag: parseInt(taggedCommitMatch[4], 10),
      commitId: taggedCommitMatch[5],
      dirty: isDirty,
      full: version,
    };
  }

  const tagMatch = cleanVersion.match(TAG_PATTERN);
  return {
    major: tagMatch ? parseInt(tagMatch[1], 10) : null,
    minor: tagMatch ? parseInt(tagMatch[2], 10) : null,
    patch: tagMatch ? parseInt(tagMatch[3], 10) : null,
    commitsAfterTag: 0,
    commitId: null,
    dirty: isDirty,
    full: version,
  };
}

/**
 * Classify the compatibility between two version strings.
 *
 * Precedence (evaluated in this order):
 * 1. **missing** — one side has no version info (sentinels: undefined, null, "",
 *    "unknown", "v0.0.0-unknown"). Absent info wins over everything.
 * 2. **dirty** — either side ends in `-dirty`. Ranks ABOVE `identical`: two equal
 *    `-dirty` strings do NOT prove identical code, because uncommitted changes
 *    aren't captured in the version string — so dirty must surface even when the
 *    strings match exactly.
 * 3. **identical** — full strings are exactly equal (same clean build — no dirty
 *    on either side)
 * 4. **indeterminate** — either side has no parseable semver (bare hash — no tag)
 * 5. **incompatible** — major.minor differ
 * 6. **compatible** — major.minor equal, full strings differ
 */
export function classifyVersionCompatibility(
  theirs: string | null | undefined,
  mine: string | null | undefined,
): CompatibilityTier {
  const a = normalizeInput(theirs);
  const b = normalizeInput(mine);

  if (a === undefined || b === undefined) return "missing";

  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);

  // Dirty ranks above identical: equal `-dirty` strings don't prove identical
  // code, since uncommitted changes aren't captured in the version string.
  if (partsA.dirty || partsB.dirty) return "dirty";
  if (a === b) return "identical";
  if (partsA.major === null || partsB.major === null) return "indeterminate";
  if (partsA.major !== partsB.major || partsA.minor !== partsB.minor) {
    return "incompatible";
  }
  return "compatible";
}
