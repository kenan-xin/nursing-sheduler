"""Workspace V1 `dates.importPublicHolidays` (bead 6975): accepted, never solved.

The web app remembers its "Import Singapore public holidays" switch in a Workspace
backup. It is authoring state only: the strict conversion drops it, so a backup
carrying it converts byte-identically to one that does not.
"""

import pytest
from pydantic import ValidationError
from ruamel.yaml import YAML

from nurse_scheduling.server.scheduling_input import canonicalize_submission
from nurse_scheduling.server.workspace import WorkspaceSchedulingDataV1

_HEAD = """\
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
{switch}people:
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

_OFF = _HEAD.format(switch="  importPublicHolidays: false\n")
_PLAIN = _HEAD.format(switch="")


def test_accepts_the_switch():
    workspace = WorkspaceSchedulingDataV1(**YAML(typ="safe").load(_OFF))
    assert workspace.dates.importPublicHolidays is False


def test_rejects_a_non_boolean_switch():
    with pytest.raises(ValidationError):
        WorkspaceSchedulingDataV1(**YAML(typ="safe").load(_HEAD.format(switch="  importPublicHolidays: off2\n")))


def test_strict_conversion_drops_the_switch():
    assert canonicalize_submission(_OFF.encode()) == canonicalize_submission(_PLAIN.encode())
