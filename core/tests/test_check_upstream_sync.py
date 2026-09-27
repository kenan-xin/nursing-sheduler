"""core/ matches the recorded upstream blobs once the v2 patches are reversed."""

from scripts import check_upstream_sync, sync_upstream


def test_git_blob_sha_matches_git_hash_object():
    assert check_upstream_sync.git_blob_sha(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_core_matches_recorded_upstream():
    assert check_upstream_sync.main([]) == 0


def test_sync_plan_acts_by_origin_class():
    manifest = {
        "file": [
            {"path": "a.py", "class": "verbatim", "upstream_blob": "1"},
            {"path": "b.py", "class": "patched", "upstream_blob": "1", "patches": ["X.patch"]},
            {"path": "c.py", "class": "v2-only", "note": "v2"},
            {"path": "ai/*", "class": "excluded", "note": "X5"},
        ]
    }
    old = {"a.py": "1", "b.py": "1", "ai/x.py": "1"}
    new = {"a.py": "2", "b.py": "2", "ai/x.py": "2", "c.py": "1", "d.py": "1"}
    actions, problems = sync_upstream.plan(manifest, old, new)
    assert actions == ["copy   a.py", "skip   ai/x.py (excluded: X5)", "patch  b.py (copy, then re-apply X.patch)"]
    assert [p.split(":")[0] for p in problems] == ["c.py", "d.py"]
