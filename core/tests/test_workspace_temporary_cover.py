"""Workspace V1 `temporaryCover` (d582): structural acceptance, strict rejection.

A temporary cover is a display-only staffing credit the web app applies before
solving (spec §1/§2), never a solver person. The Workspace V1 model therefore
owns the optional field so a backup carrying covers still LOADS, while the strict
conversion refuses a non-empty list with one located issue: the decrement is a
web step, so only the strict document the web app produces is solvable.
"""

import pytest
from ruamel.yaml import YAML

from nurse_scheduling.server.scheduling_errors import SchedulingContentError
from nurse_scheduling.server.scheduling_input import canonicalize_submission
from nurse_scheduling.server.workspace import WorkspaceSchedulingDataV1

COVER_MESSAGE = "Temporary cover is applied by the web app. Submit the strict document it produces."

_HEAD = """\
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
"""

_NON_EMPTY = (
    _HEAD
    + """\
temporaryCover:
  - name: Haseena (Ward 3)
    date: 2025-01-01
    shiftType: day
    groups:
      - Seniors
"""
)

_EMPTY = _HEAD + "temporaryCover: []\n"


def _content_error(document: str) -> SchedulingContentError:
    with pytest.raises(SchedulingContentError) as excinfo:
        canonicalize_submission(document.encode())
    return excinfo.value


def test_accepts_temporary_cover_field():
    # The structural model owns the field (`extra="forbid"` would otherwise reject an
    # unknown top-level key), and each entry's shape is validated.
    workspace = WorkspaceSchedulingDataV1(**YAML(typ="safe").load(_NON_EMPTY))
    cover = workspace.temporaryCover[0]
    assert cover.name == "Haseena (Ward 3)"
    assert cover.shiftType == "day"
    assert cover.groups == ["Seniors"]


def test_strict_conversion_rejects_non_empty_cover_with_located_issue():
    error = _content_error(_NON_EMPTY)
    assert error.error_code == "invalid_scheduling_data"
    assert error.as_response()["error"]["issues"] == [
        {"path": ["temporaryCover"], "code": "invalid_value", "message": COVER_MESSAGE}
    ]


def test_empty_cover_converts_unchanged():
    # An empty list is the omitted default: byte-identical strict output to a
    # document that never carried the key.
    assert canonicalize_submission(_EMPTY.encode()) == canonicalize_submission(_HEAD.encode())
