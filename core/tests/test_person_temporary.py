"""Patch P1 is retired (bead nursing-sheduler-pknr): `Person` is genie again, so `temporary` is rejected."""

import pytest
from pydantic import ValidationError

from nurse_scheduling.models import Person


def test_temporary_is_no_longer_a_person_field():
    with pytest.raises(ValidationError):
        Person(id="float1", temporary=True)
