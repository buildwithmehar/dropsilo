"""Launch a known course CLI with an operator credential kept out of OS argv."""
import os
import runpy
import sys
from pathlib import Path


def main():
    engine, target, output = sys.argv[1:]
    credential_path = Path(os.environ.pop("EASYSAVE_PROVIDER_CREDENTIAL_FILE"))
    if credential_path.stat().st_size > 16_384:
        raise ValueError("Invalid provider credential file.")
    credential = credential_path.read_text(encoding="utf-8-sig").strip()
    if not credential or any(char.isspace() for char in credential):
        raise ValueError("Invalid provider credential file.")

    if engine == "coursera-dl":
        from coursera.coursera_dl import main as coursera
        sys.argv = ["coursera-dl", "-ca", credential, "--path", output, target]
        raise SystemExit(coursera())

    if engine == "udemy-downloader":
        # The CLI uses the isolated job working directory for tool settings.
        sys.argv = ["udemy-downloader", "--bearer", credential, "--out", output,
                    "--download-assets", "--download-captions", "-cd", "2", target]
        runpy.run_module("udemy_downloader", run_name="__main__")
        return

    raise ValueError("Unknown course engine.")


if __name__ == "__main__":
    main()
