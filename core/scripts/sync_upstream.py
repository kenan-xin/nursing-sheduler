"""Sync core/ from the pinned v1 feature/genie commit to a newer one.

Reads upstream-patches/manifest.toml and acts on each upstream file that changed
between the pinned commit and `--to`, by its origin class:

- `verbatim`: copy the new upstream file.
- `patched`: copy the new upstream file, then re-apply its v2 patch.
- `excluded`: skip.
- no row, or a `v2-only` row: stop and report; a person classifies it first.

Without `--apply` it only prints the plan and the problems (a dry run). With
`--apply` it writes the files, moves the manifest to the new commit, and
rebuilds the patch files. A patch that no longer applies leaves `*.rej` files:
fix the file by hand, then run `--refresh-patches`. Finish with
`python -m scripts.check_upstream_sync` and the core suite.

Run from core/:
    python -m scripts.sync_upstream --repo ~/work/nurse-scheduling --to feature/genie
    python -m scripts.sync_upstream --repo ~/work/nurse-scheduling --to feature/genie --apply
"""

import argparse
import fnmatch
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from scripts.check_upstream_sync import CORE, PATCH_DIR, TRACKED, load_manifest

MANIFEST = PATCH_DIR / "manifest.toml"


def git(repo: str, *args: str) -> bytes:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True).stdout


def upstream_tree(repo: str, commit: str) -> dict[str, str]:
    """Upstream core/ files at a commit: {path relative to core/: blob SHA}."""
    tree = {}
    for line in git(repo, "ls-tree", "-r", commit, "core/").decode().splitlines():
        meta, path = line.split("\t", 1)
        tree[path.removeprefix("core/")] = meta.split()[2]
    return tree


def plan(manifest: dict, old: dict[str, str], new: dict[str, str]) -> tuple[list[str], list[str]]:
    """Return (actions, problems) for moving from the `old` to the `new` upstream tree."""
    rows = {e["path"]: e for e in manifest["file"] if e["class"] != "excluded"}
    excluded = [e for e in manifest["file"] if e["class"] == "excluded"]
    problems = [
        f"{p}: manifest blob {e['upstream_blob'][:12]} is not upstream {old.get(p, 'missing')[:12]} at the pin"
        for p, e in rows.items()
        if e["class"] in TRACKED and old.get(p) != e["upstream_blob"]
    ]
    problems += [
        f"{p}: deleted upstream; delete it or make it v2-only"
        for p, e in rows.items()
        if e["class"] in TRACKED and p not in new
    ]
    actions = []
    for path in sorted(new):
        row = rows.get(path)
        skip = next((e for e in excluded if fnmatch.fnmatch(path, e["path"])), None)
        if row is None and skip is None:
            problems.append(f"{path}: new upstream file with no row; add a row to manifest.toml")
        elif row is not None and row["class"] == "v2-only":
            problems.append(f"{path}: upstream now has a file that v2 owns (v2-only); decide which wins")
        elif old.get(path) == new[path]:
            continue
        elif skip is not None:
            actions.append(f"skip   {path} (excluded: {skip['note']})")
        elif row["class"] == "verbatim":
            actions.append(f"copy   {path}")
        else:
            actions.append(f"patch  {path} (copy, then re-apply {', '.join(row['patches'])})")
    return actions, problems


def diff_file(upstream: bytes, path: str) -> str:
    """`git diff` from the upstream bytes to the working file, with a/core and b/core paths."""
    with tempfile.TemporaryDirectory() as scratch:
        a, b = Path(scratch, "a/core", path), Path(scratch, "b/core", path)
        a.parent.mkdir(parents=True)
        b.parent.mkdir(parents=True)
        a.write_bytes(upstream)
        shutil.copyfile(CORE / path, b)
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.abbrev=7",
                "diff",
                "--no-index",
                "--no-prefix",
                "--no-color",
                "--no-ext-diff",
                f"a/core/{path}",
                f"b/core/{path}",
            ],
            cwd=scratch,
            capture_output=True,
            text=True,
        )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return result.stdout


def refresh_patches(repo: str, manifest: dict) -> None:
    """Rebuild each patch file from the pinned upstream blob to the working file, keeping its # header."""
    files: dict[str, list[dict]] = {}
    for entry in manifest["file"]:
        if len(entry.get("patches", [])) > 1:
            raise SystemExit(f"{entry['path']}: one patch per file, so the patch can be rebuilt")
        for name in entry.get("patches", []):
            files.setdefault(name, []).append(entry)
    for name in manifest["patch_order"]:
        path = PATCH_DIR / name
        text = path.read_text(encoding="utf-8")
        header = text[: text.index("diff --git")]
        body = "".join(
            diff_file(git(repo, "cat-file", "blob", e["upstream_blob"]), e["path"])
            for e in sorted(files[name], key=lambda e: e["path"])
        )
        path.write_text(header + body, encoding="utf-8")


def apply(repo: str, manifest: dict, commit: str, new: dict[str, str], actions: list[str]) -> list[str]:
    text = MANIFEST.read_text(encoding="utf-8")
    rows = {e["path"]: e for e in manifest["file"]}
    rejected = []
    for action in actions:
        verb, path = action.split()[:2]
        if verb == "skip":
            continue
        (CORE / path).write_bytes(git(repo, "cat-file", "blob", new[path]))
        text, count = re.subn(
            rf'^(\s*\{{ path = "{re.escape(path)}",.*upstream_blob = ")\w+(")', rf"\g<1>{new[path]}\2", text, flags=re.M
        )
        if count != 1:
            raise SystemExit(f"{path}: could not update its upstream_blob in manifest.toml")
        for name in rows[path].get("patches", []):
            result = subprocess.run(
                ["git", "apply", "--reject", f"--include=core/{path}", str(PATCH_DIR / name)],
                cwd=CORE.parent,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                rejected.append(f"{path}: {name} did not apply; see {path}.rej")
    MANIFEST.write_text(re.sub(r'^upstream_commit = "\w+"', f'upstream_commit = "{commit}"', text, flags=re.M))
    return rejected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, help="path to the v1 nurse-scheduling clone")
    parser.add_argument("--to", default="feature/genie", help="new upstream ref (default feature/genie)")
    parser.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    parser.add_argument("--refresh-patches", action="store_true", help="only rebuild the patch files")
    args = parser.parse_args()

    manifest = load_manifest()
    if args.refresh_patches:
        refresh_patches(args.repo, manifest)
        return 0
    old_commit = manifest["upstream_commit"]
    commit = git(args.repo, "rev-parse", "--short=7", args.to).decode().strip()
    old, new = upstream_tree(args.repo, old_commit), upstream_tree(args.repo, commit)
    actions, problems = plan(manifest, old, new)
    print(f"upstream {old_commit} -> {commit}: {len(actions)} changed file(s), {len(problems)} problem(s)")
    print("\n".join(actions + [f"PROBLEM {p}" for p in problems]))
    if problems or not args.apply:
        return 1 if problems else 0
    rejected = apply(args.repo, manifest, commit, new, actions)
    if rejected:
        print("\n".join(rejected) + "\nFix these by hand, then run --refresh-patches.")
        return 1
    refresh_patches(args.repo, load_manifest())
    print("Done. Now run: python -m scripts.check_upstream_sync && pytest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
