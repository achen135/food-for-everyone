"""Test package marker.

Present so `tests.conftest` has exactly one module name. Without it mypy sees
the file as both `conftest` and `tests.conftest` and refuses to continue.
"""
