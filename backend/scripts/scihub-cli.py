"""Run the upstream Sci-Hub CLI with a configured HTTPS mirror and TLS checks."""
import importlib.util
import sys
from pathlib import Path

import requests


class VerifiedSession(requests.Session):
    def request(self, method, url, **kwargs):
        kwargs["verify"] = True
        kwargs.setdefault("timeout", 20)
        return super().request(method, url, **kwargs)


def main():
    script, mirror, identifier, directory = sys.argv[1:]
    spec = importlib.util.spec_from_file_location("upstream_scihub", script)
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)

    class ConfiguredSciHub(upstream.SciHub):
        def __init__(self):
            self.sess = VerifiedSession()
            self.sess.headers = upstream.HEADERS
            self.available_base_url_list = [mirror]
            self.base_url = mirror + "/"

    result = ConfiguredSciHub().fetch(identifier)
    data = result.get("pdf", b"")
    if not data.startswith(b"%PDF-"):
        raise ValueError("The selected source did not return a PDF.")
    name = identifier.replace("/", "_").replace(":", "_")
    with (Path(directory) / (name + ".pdf")).open("xb") as output:
        output.write(data)


if __name__ == "__main__":
    main()
