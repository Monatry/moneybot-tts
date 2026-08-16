#!/usr/bin/env python3
"""Stamp a content hash onto every asset URL in public/index.html.

Cloudflare fronts this host and rewrites Cache-Control to max-age=14400 for static
extensions, so the `no-cache` nginx sends never reaches the browser: an edited stylesheet or
script stays pinned in a visitor's cache for four hours. index.html itself is never cached
(cf-cache-status: DYNAMIC), so the query string in it is what decides which copy gets loaded.

A hand-maintained `?v=N` is one edit away from being wrong, and wrong here is not a cosmetic
stale style — HTML and script are cached separately, so a browser can pair new markup with an
old script. That is what emptied the voice list once: the toolbar-era script ran against markup
that no longer had a toolbar, threw on the missing element, and never reached render().

So the version is the file's own hash. Re-running after any edit produces exactly the URLs that
edit needs, and re-running after no edit changes nothing.

    tools/stamp-assets.py            # rewrite the query strings in public/index.html
    tools/stamp-assets.py --check    # exit 1 if any of them is stale

Only `samples/` and `fonts/` are left alone: they are the bulk of the bytes, they change only
when a voice is added, and a new voice arrives under a new filename anyway.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "public")
PAGE = os.path.join(PUBLIC, "index.html")

ASSETS = ("styles.css", "app.js", "voices.js", "wormo.png")


def digest(name: str) -> str:
    with open(os.path.join(PUBLIC, name), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:8]


def stamp(html: str) -> tuple[str, dict[str, str]]:
    versions = {}
    for name in ASSETS:
        version = digest(name)
        versions[name] = version
        # Matches href="app.js", href="app.js?v=abc123" and the src= forms alike, and leaves
        # any other attribute on the tag untouched.
        pattern = re.compile(r'((?:href|src)=")' + re.escape(name) + r'(?:\?v=[^"]*)?(")')
        html, count = pattern.subn(r"\g<1>" + name + "?v=" + version + r"\g<2>", html)
        if count != 1:
            raise SystemExit(f"expected exactly one reference to {name} in index.html, found {count}")
    return html, versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    with open(PAGE, encoding="utf-8") as fh:
        current = fh.read()
    stamped, versions = stamp(current)

    if args.check:
        if stamped != current:
            print("index.html asset versions are stale; run tools/stamp-assets.py", file=sys.stderr)
            return 1
        print("index.html asset versions are up to date")
        return 0

    if stamped == current:
        print("index.html already stamped; nothing to do")
        return 0

    with open(PAGE, "w", encoding="utf-8") as fh:
        fh.write(stamped)
    print("stamped " + ", ".join(f"{n}?v={v}" for n, v in versions.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
