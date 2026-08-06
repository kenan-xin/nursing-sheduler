"""Golden-vector tests for the Python `OptimizeBasisV2` canonical encoder (T08)."""

import json
from pathlib import Path

import pytest

from nurse_scheduling.server.optimize_basis import (
    NormalizedOptions,
    OptimizeBasisError,
    OptimizeBasisV2,
    compute_basis_id,
    encode_optimize_basis_v2,
    sha256_hex,
)


GOLDEN_PATH = Path(__file__).resolve().parents[2] / "contracts" / "optimize-basis-v2.golden.json"
"""The SAME file `web/lib/optimize/basis/optimize-basis.test.ts` asserts against.

The two encoders are independent implementations; pinning both to one committed
file is what makes a one-sided change fail rather than silently fork the identity
of retained Optimize evidence.
"""


def _load_golden() -> dict:
    """Read the shared cross-language golden-vector document."""
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


GOLDEN = _load_golden()


def _basis_from_wire(wire: dict) -> OptimizeBasisV2:
    """Build a basis from the golden file's camelCase wire shape.

    Field access is deliberately direct (not `.get`) for required keys so a vector
    that drops a field fails loudly instead of silently encoding a default.
    """
    options = wire["normalizedOptions"]
    return OptimizeBasisV2(
        schema_version=wire["schemaVersion"],
        submission_contract_version=wire["submissionContractVersion"],
        workspace_schema_version=wire["workspaceSchemaVersion"],
        serializer_version=wire["serializerVersion"],
        anonymization_mode=wire["anonymizationMode"],
        input_sha256=wire["inputSha256"],
        normalized_options=NormalizedOptions(
            solver=options["solver"],
            prettify=options["prettify"],
            timeout_seconds=options["timeoutSeconds"],
        ),
        solver_semantic_version=wire["solverSemanticVersion"],
        backend_capability_version=wire["backendCapabilityVersion"],
    )


def test_golden_file_declares_the_expected_encoding_version():
    """A bumped encoding version must be a deliberate, reviewed change."""
    assert GOLDEN["encodingVersion"] == "optimize-basis/v2"
    assert len(GOLDEN["vectors"]) > 0
    assert len(GOLDEN["invalid"]) > 0


@pytest.mark.parametrize("vector", GOLDEN["vectors"], ids=lambda vector: vector["name"])
def test_encoding_matches_the_golden_bytes(vector):
    """Every vector encodes to the exact committed UTF-8 bytes."""
    encoded = encode_optimize_basis_v2(_basis_from_wire(vector["basis"]))
    assert encoded == vector["encoded"].encode("utf-8")
    assert len(encoded) == vector["encodedUtf8ByteLength"]


@pytest.mark.parametrize("vector", GOLDEN["vectors"], ids=lambda vector: vector["name"])
def test_basis_id_matches_the_golden_digest(vector):
    """`basis_id` is the SHA-256 of the canonical encoding, not of any other form."""
    basis = _basis_from_wire(vector["basis"])
    assert compute_basis_id(basis) == vector["basisId"]
    assert compute_basis_id(basis) == sha256_hex(encode_optimize_basis_v2(basis))


@pytest.mark.parametrize("vector", GOLDEN["invalid"], ids=lambda vector: vector["name"])
def test_invalid_bases_are_rejected_not_coerced(vector):
    """An out-of-domain field raises instead of encoding a silently coerced value."""
    with pytest.raises(OptimizeBasisError):
        encode_optimize_basis_v2(_basis_from_wire(vector["basis"]))


def test_every_golden_vector_has_a_distinct_basis_id():
    """No two committed vectors collide, so each field genuinely changes identity."""
    ids = [vector["basisId"] for vector in GOLDEN["vectors"]]
    assert len(set(ids)) == len(ids)


def test_a_boolean_field_does_not_alias_the_matching_string():
    """`prettify: true` and a `"true"` string in another field encode differently."""
    encoded = encode_optimize_basis_v2(
        _basis_from_wire(
            {
                **GOLDEN["vectors"][0]["basis"],
                "normalizedOptions": {
                    "solver": "ortools/cp-sat",
                    "prettify": True,
                    "timeoutSeconds": 300,
                },
            }
        )
    )
    assert b"normalizedOptions.prettify=b:true\n" in encoded
    assert b"normalizedOptions.prettify=s:true\n" not in encoded


def test_an_injected_field_line_cannot_be_forged_through_a_string_value():
    """A newline inside a value is escaped, so it cannot open a second field line."""
    forged = _basis_from_wire(
        {
            **GOLDEN["vectors"][0]["basis"],
            "serializerVersion": "x\nsolverSemanticVersion=s:forged",
        }
    )
    # The forged text survives as escaped CONTENT of the serializerVersion line.
    # What must not happen is it becoming a LINE of its own, so the assertion is on
    # the line structure, not on a substring of the whole document.
    lines = encode_optimize_basis_v2(forged).decode("utf-8").split("\n")
    assert "solverSemanticVersion=s:forged" not in lines
    assert [line for line in lines if line.startswith("solverSemanticVersion=")] == [
        "solverSemanticVersion=s:" + GOLDEN["vectors"][0]["basis"]["solverSemanticVersion"]
    ]
    # Header + 11 fields, each LF-terminated, so the split yields one trailing "".
    assert len(lines) == 13
