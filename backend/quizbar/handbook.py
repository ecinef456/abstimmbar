# SPDX-License-Identifier: Apache-2.0
"""The fork's handbook (``handbook/handbook.typ``), shown in the app (? menu
→ Handbook) as HTML and downloadable as PDF. Typst compiles the same file
for both; the site's address and the signed-in user are filled in, so the
file itself holds nothing personal."""
import re
from pathlib import Path

import typst

SOURCE = Path(__file__).resolve().parent / "handbook" / "handbook.typ"
_cache = {}
BODY = re.compile(r"<body>(.*)</body>", re.DOTALL)


def _compile(fmt, site, user):
    key = (fmt, SOURCE.stat().st_mtime_ns, site, user)
    if key not in _cache:
        if len(_cache) > 16:
            _cache.clear()
        out = typst.compile(
            str(SOURCE), format=fmt if fmt == "html" else "pdf", sys_inputs={"site": site, "user": user}
        )
        if fmt == "html":
            match = BODY.search(out.decode())
            out = match.group(1) if match else out.decode()
        _cache[key] = out
    return _cache[key]


def html(site, user):
    """The handbook's content as an HTML fragment (no <html>/<body>)."""
    return _compile("html", site, user)


def pdf(site, user):
    return _compile("pdf", site, user)
