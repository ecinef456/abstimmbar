# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Prompt and strict parsing for the AI optimisation of a live mind map
(stage 3, "Mindmap optimieren").

The model gets the visible tree (ids, terms, descriptions, levels, whether a
term is fixed = presenter-added or predefined), the question and the chosen
options, and answers with a list of operations: ``merge``, ``rename``,
``add`` (new parent term, temp ``ref``) and ``move``. Only question text,
terms, descriptions and their position in the tree are sent — never
participant tokens or any other participant data. ``parse_ops`` keeps only
well-formed entries; ``live.mindmap.simulate_ops``/``apply_ops`` then check
every operation against the map with the moderation rules."""
import json

from rooms.mindmap import seed_langs

from .ai_freetext_summary import context_block, question_context
from .mindmap import AI_OPS_MAX, MINDMAP_MAX_NODES, root_label

REASON_MAX = 200
REF_MAX = 20
TEXT_MAX = 200  # raw; the term itself is cleaned/limited by the simulation
DESCRIPTION_MAX = 200

LANGUAGE_NAMES = {"de": "Deutsch", "en": "Englisch"}


def _nodes(tree):
    """Visible nodes (hidden subtrees left out), depth-first, at most
    ``MINDMAP_MAX_NODES``. Returns ``(nodes, truncated)``."""
    result = []
    truncated = False

    def walk(entries, parent, level):
        nonlocal truncated
        for entry in entries:
            if entry.get("hidden"):
                continue
            if len(result) >= MINDMAP_MAX_NODES:
                truncated = True
                return
            node = {
                "id": entry["id"],
                "parent": parent,
                "text": entry["text"],
                "level": level,
                "fixed": bool(entry.get("seeded") or entry.get("teacher")),
            }
            descriptions = " / ".join(entry.get("descriptions") or [])
            if descriptions:
                node["description"] = descriptions[:DESCRIPTION_MAX]
            result.append(node)
            walk(entry.get("children") or [], entry["id"], level + 1)

    walk(tree["nodes"], None, 1)
    return result, truncated


def visible_nodes(tree):
    """The visible terms of a presenter tree as prompt nodes."""
    return _nodes(tree)[0]


def build_prompt(tree, question, options):
    """``(system, user)`` for ``ai.chat_json``. ``tree`` = the presenter
    payload (``mindmap.build_tree(presenter=True)``), ``options`` =
    ``mindmap.ai_settings`` (merge, translate, target_lang, restructure)."""
    language = LANGUAGE_NAMES.get(options["target_lang"], options["target_lang"])
    allowed = []
    if options.get("merge"):
        allowed.append(
            '- "merge" {"source", "target"}: "source" ist ein Duplikat, Synonym '
            "oder eine Schreibvariante von \"target\" und wird darin "
            "zusammengeführt (Unterbegriffe und Nennungen wandern mit). "
            "\"source\" darf nie ein Begriff mit \"fixed\": true sein; nimm in "
            "diesem Fall den fixen Begriff als \"target\"."
        )
    if options.get("translate"):
        allowed.append(
            f'- "rename" {{"node", "text"}}: Begriff in die Zielsprache {language} '
            "übersetzen oder die Schreibweise vereinheitlichen (kurz, ohne "
            "Satzzeichen am Ende). Nie für Begriffe mit \"fixed\": true."
        )
    if options.get("restructure"):
        allowed.append(
            '- "add" {"ref", "parent", "text"}: neuer Oberbegriff unter '
            '"parent" (Begriffs-id oder null = Hauptast); "ref" ist eine neue '
            'Kennung wie "n1", auf die sich spätere Operationen beziehen.'
        )
        allowed.append(
            '- "move" {"node", "parent"}: Begriff (mit seinen Unterbegriffen) '
            'unter einen passenderen Begriff, einen neuen Oberbegriff ("ref") '
            "oder null (Hauptast) verschieben. Nie für Begriffe mit "
            "\"fixed\": true."
        )
    system = (
        "Du hilfst Lehrenden, eine gemeinsam von Studierenden erstellte "
        "Mindmap aufzuräumen. Du erhältst die Frage und die Begriffe als "
        "Baum (id, parent = id des Oberbegriffs oder null für einen Hauptast, "
        "text, optional description, level = Ebene ab 1, fixed = von den "
        "Lehrenden vorgegeben).\n"
        "Schlage Operationen vor; erlaubt sind ausschließlich:\n"
        + "\n".join(allowed)
        + "\n"
        "Regeln:\n"
        "- Lösche oder verstecke nichts; jeder Begriff bleibt (ggf. "
        "zusammengeführt) erhalten.\n"
        "- Begriffe mit \"fixed\": true behalten Namen und Platz.\n"
        f"- Die Mindmap hat höchstens {question.mindmap_depth} Ebenen; keine "
        "Operation darf einen Begriff tiefer setzen.\n"
        "- Verwende nur vorhandene ids bzw. eigene \"ref\"-Kennungen früherer "
        "\"add\"-Operationen; erfinde keine ids.\n"
        "- Die Operationen werden in der angegebenen Reihenfolge ausgeführt.\n"
        "- Wenige, wirklich hilfreiche Änderungen sind besser als viele; "
        "ändere nichts, was schon gut ist.\n"
        "- Gib zu jeder Operation einen kurzen Grund \"reason\" (Deutsch, "
        "höchstens 10 Wörter) an.\n"
        "Antworte ausschließlich mit JSON der Form "
        '{"ops": [{"type": "merge", "source": 12, "target": 7, "reason": "…"}, '
        '{"type": "add", "ref": "n1", "parent": null, "text": "…", "reason": "…"}, '
        '{"type": "move", "node": 15, "parent": "n1", "reason": "…"}]}.'
    )
    nodes, truncated = _nodes(tree)
    root = root_label(question)
    canonical, _ = seed_langs()
    payload = {
        "root": root.get(canonical) or next((v for v in root.values() if v), ""),
        "target_language": language,
        "nodes": nodes,
    }
    if truncated:
        payload["note"] = "Baum gekürzt (zu viele Begriffe)."
    user = (
        context_block(question_context(question))
        + "Mindmap:\n"
        + json.dumps(payload, ensure_ascii=False)
    )
    return system, user


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_ref(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= REF_MAX


def _text(value):
    return isinstance(value, str) and value.strip() and len(value) <= TEXT_MAX


def raw_count(data):
    """How many entries the reply's ``ops`` list had (for the dropped count)."""
    raw = data.get("ops") if isinstance(data, dict) else None
    return min(len(raw), AI_OPS_MAX) if isinstance(raw, list) else 0


def parse_ops(data):
    """Well-formed ops of the model's reply, numbered (``index``) in order:
    ``merge {source, target}``, ``rename {node, text}``, ``add {ref, parent,
    text}``, ``move {node, parent}`` (+ ``reason``). ``parent`` is a node id,
    an earlier ``add``'s ref or None. Malformed entries are dropped; a ref
    used twice keeps its first ``add``."""
    raw = data.get("ops") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    ops, refs = [], set()
    for item in raw[:AI_OPS_MAX]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        op = None
        if kind == "merge":
            if _is_id(item.get("source")) and _is_id(item.get("target")):
                op = {"type": kind, "source": item["source"], "target": item["target"]}
        elif kind == "rename":
            if _is_id(item.get("node")) and _text(item.get("text")):
                op = {"type": kind, "node": item["node"], "text": item["text"]}
        elif kind in ("add", "move"):
            parent = item.get("parent")
            if not (parent is None or _is_id(parent) or _is_ref(parent)):
                continue
            if isinstance(parent, str):
                parent = parent.strip()
                if parent not in refs:  # must name an EARLIER add
                    continue
            if kind == "add":
                ref = item.get("ref")
                if _is_ref(ref) and ref.strip() not in refs and _text(item.get("text")):
                    refs.add(ref.strip())
                    op = {"type": kind, "ref": ref.strip(), "parent": parent,
                          "text": item["text"]}
            elif _is_id(item.get("node")):
                op = {"type": kind, "node": item["node"], "parent": parent}
        if op is None:
            continue
        reason = item.get("reason")
        op["reason"] = " ".join(reason.split())[:REASON_MAX] if isinstance(reason, str) else ""
        op["index"] = len(ops)
        ops.append(op)
    return ops
