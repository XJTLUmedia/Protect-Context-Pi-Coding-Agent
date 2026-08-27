"""`python -m protect_context` entry point — delegates to the CLI."""

from .cli import main

raise SystemExit(main())
