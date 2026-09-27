"""Check that core/ matches the recorded upstream (v1 feature/genie) blobs.

For every `verbatim` or `patched` row in upstream-patches/manifest.toml, copy the
file into a scratch tree, reverse-apply the recorded v2 patches newest first, and
compare the git blob SHA with the recorded upstream blob. Needs `git` on PATH but
no access to the upstream repository.

Run from core/: `python -m scripts.check_upstream_sync`.
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]
PATCH_DIR = CORE / "upstream-patches"
TRACKED = ("verbatim", "patched")


def git_blob_sha(data: bytes) -> str:
    """Return the SHA-1 that `git hash-object` gives these bytes."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def main() -> int:
    manifest = tomllib.loads((PATCH_DIR / "manifest.toml").read_text(encoding="utf-8"))
    tracked = [entry for entry in manifest["file"] if entry["class"] in TRACKED]
    failures: list[str] = [
        f"{entry['path']}: unknown class {entry['class']!r}"
        for entry in manifest["file"]
        if entry["class"] not in TRACKED
    ]
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        for entry in tracked:
            target = root / "core" / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(CORE / entry["path"], target)
        for name in reversed(manifest["patch_order"]):
            result = subprocess.run(
                ["git", "apply", "-R", str(PATCH_DIR / name)], cwd=root, capture_output=True, text=True
            )
            if result.returncode != 0:
                failures.append(f"{name}: does not reverse-apply: {result.stderr.strip()}")
        for entry in tracked:
            actual = git_blob_sha((root / "core" / entry["path"]).read_bytes())
            if actual != entry["upstream_blob"]:
                failures.append(f"{entry['path']}: blob {actual} differs from upstream {entry['upstream_blob']}")
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f"checked {len(tracked)} files against {manifest['upstream_commit']}: {len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
