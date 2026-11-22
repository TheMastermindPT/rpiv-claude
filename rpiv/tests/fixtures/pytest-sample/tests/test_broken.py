"""rpiv test data: a test file that fails to load (an ImportError at collection)."""

from demo import missing


def test_b3_x():
    assert missing
