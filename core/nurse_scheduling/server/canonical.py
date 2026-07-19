"""Canonical strict-scenario YAML serialization for the job submission boundary."""

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

from io import BytesIO
from typing import Any

from ruamel.yaml import YAML

from ..models import NurseSchedulingData


def _app_version_last(data: dict[str, Any]) -> dict[str, Any]:
    """Return the mapping with `appVersion` moved to the end when present.

    `appVersion` is build provenance rather than scheduling semantics, so the
    canonical document always emits it last (technical plan §4).
    """
    if "appVersion" not in data:
        return data
    reordered = {key: value for key, value in data.items() if key != "appVersion"}
    reordered["appVersion"] = data["appVersion"]
    return reordered


def _new_yaml() -> YAML:
    """Build the pinned ruamel YAML 1.2 emitter used for canonical output."""
    yaml = YAML()
    yaml.default_flow_style = False
    yaml.allow_unicode = True
    yaml.width = 1_000_000
    yaml.version = (1, 2)
    # Disable anchors/aliases so repeated values serialize by value, not reference.
    yaml.representer.ignore_aliases = lambda _data: True
    return yaml


def dump_canonical_strict_yaml(model: NurseSchedulingData) -> bytes:
    """Serialize a validated strict model to canonical UTF-8 YAML 1.2 bytes.

    The source is `model_dump(mode="json", exclude_none=True)` with declared field
    order preserved and `appVersion` moved last. Output is block style, allows
    Unicode, uses LF newlines, and ends with exactly one newline. Dates serialize
    as ISO strings and infinite weights as the ruamel `.inf` scalar the existing
    loader accepts.
    """
    data = _app_version_last(model.model_dump(mode="json", exclude_none=True))
    buffer = BytesIO()
    _new_yaml().dump(data, buffer)
    text = buffer.getvalue().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if not text.endswith("\n"):
        text += "\n"
    return text.encode("utf-8")
