"""Explicit, opt-in operational scripts for the nurse-scheduling backend.

Modules here are runnable tools and are deliberately kept out of the pytest test
tree (see pyproject ``testpaths``) so ordinary test discovery never executes
them. Their fast, pure helpers may still be imported by unit tests under
``core/tests``.
"""
