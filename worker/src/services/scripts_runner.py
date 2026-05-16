"""Bridge to the voxhorizon-marketing-dept scripts repo.

Stub for M0. The real implementation in M2 will shell out to:
    ~/github/voxhorizon-marketing-dept/scripts/<name>.{sh,py,ts}

for image generation, video assembly, b-roll scraping, etc. — capturing
stdout/stderr and surfacing structured progress events back to the caller.
"""

from __future__ import annotations

from pathlib import Path


class ScriptsRunner:
    """Stub. Real impl lands in M2."""

    def __init__(
        self,
        scripts_root: Path = Path("~/github/voxhorizon-marketing-dept/scripts").expanduser(),
    ) -> None:
        self.scripts_root = scripts_root

    async def run(self, name: str, args: list[str] | None = None) -> str:
        raise NotImplementedError("ScriptsRunner.run lands in M2.")
