# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Authoring rules of the mindmap question kind (stage 1).

A mindmap question carries optional *predefined branches* (``mindmap_seed``):
a nested list ``[{"text", "description", "children": [...]}]`` below the root
whose ``text``/``description`` are bilingual ``{de, en}`` maps (content-i18n;
a plain string is still accepted on input and means the canonical language
``CONTENT_DEFAULT_LANGUAGE``). Every branch needs a canonical-language term;
the canonical term is what the live side merges on. Levels count from the root's
children (level 1) down to ``mindmap_depth`` — the same rule the live side
applies to participant contributions. Sibling terms are deduplicated (on the
canonical term) the way participants' terms merge (``text_key``), so
materialising the seed per run never collides with the live uniqueness
constraint.
"""

import unicodedata

MINDMAP_MIN_DEPTH = 1
MINDMAP_MAX_DEPTH = 8
MINDMAP_DEFAULT_DEPTH = 5
MINDMAP_DEFAULT_MAX_PER_PERSON = 10
MINDMAP_MAX_PER_PERSON_LIMIT = 300
MINDMAP_TEXT_MAX = 60
MINDMAP_DESCRIPTION_MAX = 200
MINDMAP_SEED_MAX_NODES = 100
# Rating phase (live.mindmap_rating).
RATING_POINTS = "points"
RATING_UPDOWN = "updown"
RATING_MODE_CHOICES = (
    ("", "Off"),
    (RATING_POINTS, "Points"),
    (RATING_UPDOWN, "Plus/minus"),
)
RATING_MIN_BUDGET = 1
RATING_MAX_BUDGET = 50
RATING_DEFAULT_BUDGET = 5


def seed_langs():
    """(canonical language, all content languages) — canonical first."""
    from django.conf import settings

    canonical = settings.MODELTRANSLATION_DEFAULT_LANGUAGE
    langs = [code for code, _ in settings.LANGUAGES]
    return canonical, (canonical, *(lang for lang in langs if lang != canonical))


def seed_map(value):
    """A seed ``text``/``description`` value — a ``{lang: text}`` map or a
    legacy plain string (= canonical language) — as a full normalised map."""
    canonical, langs = seed_langs()
    if isinstance(value, dict):
        return {lang: normalize_text(value.get(lang)) for lang in langs}
    result = dict.fromkeys(langs, "")
    if isinstance(value, str):
        result[canonical] = normalize_text(value)
    return result


class SeedError(ValueError):
    """An invalid predefined-branches structure (strict mode)."""


def normalize_text(value):
    """How terms and descriptions are stored: Unicode NFKC (so composed and
    decomposed "Café" are the same string), every whitespace character a
    plain space, other control/format characters (Cc/Cf: NUL, zero-width
    space/joiner, BOM, bidi marks …) dropped, whitespace collapsed and
    stripped. NUL must never reach Postgres."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    cleaned = []
    for char in text:
        if char.isspace():
            cleaned.append(" ")
        elif unicodedata.category(char) not in ("Cc", "Cf"):
            cleaned.append(char)
    return " ".join("".join(cleaned).split())


def text_key(value):
    """Merge key for terms under one parent: normalised, case-insensitive.
    Shared with the live side (identical terms = one node). Casefolding can
    lengthen a term ("ß" → "ss"), so the key is cut to the column length
    (MINDMAP_TEXT_MAX): two terms differing only beyond that point merge."""
    return normalize_text(value).casefold()[:MINDMAP_TEXT_MAX]


def clean_seed(value, max_level, *, strict=True):
    """Return the normalised seed tree.

    ``text``/``description`` come back as full ``{lang: text}`` maps (plain
    strings are taken as the canonical language). ``strict`` (editor API)
    raises SeedError on the first problem; lenient mode (imports of foreign
    files) drops/truncates instead: invalid nodes and duplicate siblings are
    skipped, over-long text is cut (per language), a missing canonical term is
    taken from the first filled translation, levels beyond ``max_level`` and
    nodes beyond the overall cap are dropped.
    """
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        if strict:
            raise SeedError("Predefined branches must be a list.")
        return []
    count = 0

    canonical, langs = seed_langs()

    def fit(values, limit, message):
        for lang in langs:
            if len(values[lang]) > limit:
                if strict:
                    raise SeedError(message)
                values[lang] = values[lang][:limit].strip()
        return values

    def walk(nodes, level):
        nonlocal count
        result, seen = [], set()
        for raw in nodes:
            if not isinstance(raw, dict):
                if strict:
                    raise SeedError("Invalid branch.")
                continue
            text = seed_map(raw.get("text"))
            description = seed_map(raw.get("description"))
            children = raw.get("children") or []
            if not text[canonical]:
                if strict:
                    raise SeedError(
                        "Every branch needs a term in the default language."
                        if any(text.values())
                        else "Every branch needs a term."
                    )
                # Lenient (foreign imports, e.g. from an instance with another
                # canonical language): keep the term, promoting the first
                # filled translation to the canonical language.
                fallback = next((text[lang] for lang in langs if text[lang]), "")
                if not fallback:
                    continue
                text[canonical] = fallback
            text = fit(
                text, MINDMAP_TEXT_MAX,
                f"A term may have at most {MINDMAP_TEXT_MAX} characters.",
            )
            description = fit(
                description, MINDMAP_DESCRIPTION_MAX,
                f"A description may have at most {MINDMAP_DESCRIPTION_MAX} characters.",
            )
            if not isinstance(children, list):
                if strict:
                    raise SeedError("Invalid branch.")
                children = []
            key = text_key(text[canonical])
            if key in seen:
                if strict:
                    raise SeedError(
                        f"“{text[canonical]}” appears twice at the same place."
                    )
                continue
            if level > max_level:
                if strict:
                    raise SeedError(
                        "The predefined branches are deeper than the allowed depth."
                    )
                continue
            if count >= MINDMAP_SEED_MAX_NODES:
                if strict:
                    raise SeedError(
                        f"At most {MINDMAP_SEED_MAX_NODES} predefined terms."
                    )
                continue
            seen.add(key)
            count += 1
            result.append(
                {
                    "text": text,
                    "description": description,
                    "children": walk(children, level + 1),
                }
            )
        return result

    return walk(value, 1)


def clamp_depth(value):
    """Depth from foreign input: an int in 1–8, else the default."""
    if isinstance(value, int) and not isinstance(value, bool) and (
        MINDMAP_MIN_DEPTH <= value <= MINDMAP_MAX_DEPTH
    ):
        return value
    return MINDMAP_DEFAULT_DEPTH


def clamp_max_per_person(value):
    """Terms per person from foreign input: 0 (unlimited) … limit, else default."""
    if isinstance(value, int) and not isinstance(value, bool) and (
        0 <= value <= MINDMAP_MAX_PER_PERSON_LIMIT
    ):
        return value
    return MINDMAP_DEFAULT_MAX_PER_PERSON


def clamp_rating_mode(value):
    """Rating mode from foreign input: a known mode, else off."""
    return value if value in (RATING_POINTS, RATING_UPDOWN) else ""


def clamp_target_lang(value):
    """AI target language from foreign input: a content language code, else
    "" (= the canonical content language)."""
    from django.conf import settings

    codes = {code for code, _ in settings.LANGUAGES}
    return value if isinstance(value, str) and value in codes else ""


def clamp_rating_budget(value):
    """Rating budget from foreign input: an int in 1–50, else the default."""
    if isinstance(value, int) and not isinstance(value, bool) and (
        RATING_MIN_BUDGET <= value <= RATING_MAX_BUDGET
    ):
        return value
    return RATING_DEFAULT_BUDGET
