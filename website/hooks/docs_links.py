# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)
"""MkDocs hook: keep links in included repo documents working.

Pages such as installation.md pull in docs/*.md via pymdownx.snippets, so
those documents stay the single source. Their relative links point at
siblings in docs/ (e.g. ``monitoring.md`` or ``decisions/0005-….md``); a
link whose target is also a page of this site stays as it is, every other
one is rewritten to the file on GitHub instead of ending up as a dead link.

Only pages that opt in via front matter ``docs_include: true`` are touched,
so a broken link in the site's own pages still fails ``--strict``.
"""

from __future__ import annotations

import posixpath
import re
from xml.etree.ElementTree import Element

from markdown import Extension, Markdown
from markdown.treeprocessors import Treeprocessor

GITHUB_DOCS = "https://github.com/virtUOS/abstimmbar/blob/main/docs/"
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)

_state: dict = {"page": None, "files": None}


class _Rewrite(Treeprocessor):
    def run(self, root: Element) -> None:
        page = _state["page"]
        if page is None or not page.meta.get("docs_include"):
            return
        page_dir = posixpath.dirname(page.file.src_uri)
        for link in root.iter("a"):
            href = link.get("href", "")
            if not href or href.startswith("#") or _SCHEME.match(href):
                continue
            path, _, anchor = href.partition("#")
            if not path.endswith(".md"):
                continue
            target = posixpath.normpath(posixpath.join(page_dir, path))
            if _state["files"].get_file_from_path(target) is not None:
                continue
            # Included files live in docs/: resolve against that folder so
            # "./x.md" or "sub/../x.md" end up as a clean docs/ path.
            repo_path = posixpath.normpath(posixpath.join("docs", path))
            if not repo_path.startswith("docs/"):
                continue  # points outside docs/ — leave it to MkDocs' check
            url = GITHUB_DOCS + repo_path[len("docs/"):]
            link.set("href", url + (f"#{anchor}" if anchor else ""))


class _RewriteExtension(Extension):
    def extendMarkdown(self, md: Markdown) -> None:
        # Runs before MkDocs' own link handling ("relpath", priority 0).
        md.treeprocessors.register(_Rewrite(md), "abstimmbar_docs_links", 5)


def on_config(config, **kwargs):
    config.markdown_extensions.append(_RewriteExtension())
    return config


def on_files(files, config, **kwargs):
    _state["files"] = files
    return files


def on_page_markdown(markdown, page, config, files, **kwargs):
    _state["page"] = page
    return markdown
