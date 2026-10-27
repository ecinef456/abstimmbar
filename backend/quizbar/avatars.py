# SPDX-License-Identifier: Apache-2.0
"""Game avatars: the built-in physicists plus your own images.

Files live in quizbar/static/quizbar/avatars/ (served under /static/):

- ``<slug>.svg``             built-in head icons (avatar_list.py)
- ``<slug>.png|webp|jpg``     your icon: replaces the built-in one, or adds
                              a new avatar (name from the file name)
- ``<slug>-full.png|webp|jpg|svg``  optional full-body picture, shown big on
                              the phone once chosen and on the podium

Your own files are git-ignored (see the README.md in that folder).
"""
from pathlib import Path

from django.templatetags.static import static

from .avatar_list import AVATARS as BUILT_IN

FOLDER = Path(__file__).resolve().parent / "static" / "quizbar" / "avatars"
PICTURE = (".png", ".webp", ".jpg", ".jpeg")
FULL = (*PICTURE, ".svg")

_cache = {"key": None, "list": []}


def _url(name):
    return static(f"quizbar/avatars/{name}")


def _scan():
    files = {p.name for p in FOLDER.iterdir() if p.is_file()} if FOLDER.is_dir() else set()
    stems = {}
    for name in files:
        stem, dot, ext = name.rpartition(".")
        if dot:
            stems.setdefault(stem, set()).add("." + ext.lower())

    def first(stem, exts):
        found = stems.get(stem, set())
        return next((f"{stem}{e}" for e in exts if e in found), None)

    names = dict(BUILT_IN)
    slugs = [slug for slug, _ in BUILT_IN]
    # Your own icons that are not built-in become new avatars.
    for stem in sorted(stems):
        if stem.endswith("-full") or stem in names or not first(stem, PICTURE):
            continue
        slugs.append(stem)
        names[stem] = stem.replace("-", " ").replace("_", " ").title()
    out = []
    for slug in slugs:
        icon = first(slug, PICTURE) or first(slug, (".svg",))
        if icon is None:
            continue
        full = first(f"{slug}-full", FULL)
        out.append(
            {
                "slug": slug,
                "name": names[slug],
                "icon": _url(icon),
                "full": _url(full) if full else None,
            }
        )
    return out


def available():
    """[{slug, name, icon, full}] — rescanned when the folder changes."""
    try:
        key = FOLDER.stat().st_mtime_ns
    except OSError:
        key = None
    if key != _cache["key"]:
        _cache["list"], _cache["key"] = _scan(), key
    return _cache["list"]


def get(slug):
    return next((a for a in available() if a["slug"] == slug), None) if slug else None


def slugs():
    return [a["slug"] for a in available()]
