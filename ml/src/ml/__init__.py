"""Food For Everyone — ML subsystem.

The web app (TypeScript, repo root) writes an append-only `events` log. This
package reads only that log: it never touches FFE's mutable tables. See
`docs/ML Subsystem.md` for the plan and `ml/README.md` for how to run it.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
