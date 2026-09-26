"""v2 patch P1: `Person.temporary` is an authoring-only strict boolean."""

import pytest
from pydantic import ValidationError

from nurse_scheduling.models import Person


def test_temporary_true_is_accepted():
    assert Person(id="float1", temporary=True).temporary is True


def test_temporary_defaults_to_none():
    assert Person(id="alice").temporary is None


@pytest.mark.parametrize("value", ["yes", 1])
def test_temporary_rejects_non_bool(value):
    with pytest.raises(ValidationError):
        Person(id="alice", temporary=value)
