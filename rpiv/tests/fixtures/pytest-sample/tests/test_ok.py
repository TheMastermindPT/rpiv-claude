"""rpiv test data: every record shape reprove-red's pytest matcher reads."""

import pytest

from demo import add


def test_b1_add():
    assert add(1, 1) == 3


class TestBar:
    def test_b3_method(self):
        assert add(1, 2) == 3

    class TestInner:
        def test_b3_inner(self):
            assert add(2, 2) == 4


@pytest.mark.parametrize("value", [1, "a/b", "c::d", "[e]"])
def test_b2_param(value):
    assert value is None


@pytest.mark.xfail
def test_b6_xf():
    assert add(1, 1) == 0


@pytest.mark.skip(reason="sample skip")
def test_b6_skip():
    assert add(1, 1) == 2
