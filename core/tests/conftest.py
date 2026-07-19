"""Pytest fixtures shared across the server, store, and protocol test suites."""

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

import pytest

from tests.server_support import STORE_FACTORIES


@pytest.fixture(params=list(STORE_FACTORIES))
def store_factory(request):
    """Parametrize a test across memory, fakeredis, and (when available) real Redis."""
    return STORE_FACTORIES[request.param]


@pytest.fixture(params=list(STORE_FACTORIES))
def store(request):
    """Provide one store instance per backend with default event retention."""
    return STORE_FACTORIES[request.param]()
