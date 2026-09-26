"""core/ matches the recorded upstream blobs once the v2 patches are reversed."""

from scripts import check_upstream_sync


def test_git_blob_sha_matches_git_hash_object():
    assert check_upstream_sync.git_blob_sha(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_core_matches_recorded_upstream():
    assert check_upstream_sync.main() == 0
