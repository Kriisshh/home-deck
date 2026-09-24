"""Home Deck agent launcher: updates from GitHub, then starts the agent.

The logon shortcut runs this instead of agent.py. It fast-forwards the local Git copy to the latest
version on GitHub (retrying for a minute, since the network may not be up right after logon),
reinstalls dependencies if requirements.txt changed, then runs agent.py. If anything goes wrong it
logs to update.log and starts the version already on disk.
"""

import hashlib
import logging
import logging.handlers
import runpy
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
REQUIREMENTS = HERE / "requirements.txt"
CREATE_NO_WINDOW = 0x08000000

log = logging.getLogger("launcher")


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True,
                          timeout=60, creationflags=CREATE_NO_WINDOW)


def update() -> None:
    if not (REPO / ".git").exists() or not shutil.which("git"):
        log.info("Not a Git copy (or Git missing) - skipping update check")
        return
    before_rev = _git("rev-parse", "HEAD").stdout.strip()
    before_req = _digest(REQUIREMENTS)
    for attempt in range(6):
        result = _git("pull", "--ff-only", "--quiet")
        if result.returncode == 0:
            break
        log.warning("git pull failed (attempt %d): %s", attempt + 1, (result.stderr or result.stdout).strip())
        time.sleep(10)
    else:
        log.error("Could not update; starting the current version")
        return
    after_rev = _git("rev-parse", "HEAD").stdout.strip()
    if after_rev == before_rev:
        log.info("Up to date (%s)", after_rev[:7])
        return
    log.info("Updated %s -> %s", before_rev[:7], after_rev[:7])
    if _digest(REQUIREMENTS) != before_req:
        log.info("requirements.txt changed - installing dependencies")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                        "-r", str(REQUIREMENTS)], capture_output=True, timeout=600, creationflags=CREATE_NO_WINDOW)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.handlers.RotatingFileHandler(HERE / "update.log", maxBytes=200_000, backupCount=1,
                                                       encoding="utf-8")])
    try:
        update()
    except Exception:  # noqa: BLE001 - never let an update problem stop the agent from starting
        log.exception("Update check failed; starting the current version")
    logging.getLogger().handlers.clear()  # agent.py sets up its own logging
    runpy.run_path(str(HERE / "agent.py"), run_name="__main__")


if __name__ == "__main__":
    main()
