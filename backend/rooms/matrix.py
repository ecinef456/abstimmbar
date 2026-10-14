# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Authoring rules of the four-field matrix question kind.

A matrix question has two axes, each labelled at both ends (``matrix_x_from``
… ``matrix_y_to``; translatable, required in the canonical language) and
optional *categories* (``matrix_categories``): at most six entries
``{"key", "name"}`` where ``key`` is a colour of the fixed ``MATRIX_PALETTE``
and ``name`` a bilingual ``{lang: text}`` map (content-i18n; a plain string
means the canonical language, like ``mindmap.seed_map``). The category mode
decides what is stored: ``off`` = none, ``colors`` = colour only (names are
dropped), ``named`` = colour plus a name in the canonical language.
"""

from .mindmap import normalize_text, seed_langs, seed_map

# Six high-contrast colours, distinguishable for common colour-vision
# deficiencies (the frontend maps each key to a light/dark-checked value).
MATRIX_PALETTE = ("blue", "orange", "green", "red", "purple", "sky")
MATRIX_MAX_CATEGORIES = 6
MATRIX_MIN_CATEGORIES = 2
MATRIX_NAME_MAX = 40
MATRIX_TITLE_MAX = 60
MATRIX_DESCRIPTION_MAX = 200
MATRIX_AXIS_LABEL_MAX = 40
MATRIX_DEFAULT_MAX_PER_PERSON = 10
MATRIX_MIN_MAX_PER_PERSON = 1
MATRIX_MAX_PER_PERSON_LIMIT = 100

CATEGORY_OFF = "off"
CATEGORY_COLORS = "colors"
CATEGORY_NAMED = "named"
CATEGORY_MODE_CHOICES = (
    (CATEGORY_OFF, "Off"),
    (CATEGORY_COLORS, "Colors only"),
    (CATEGORY_NAMED, "Named"),
)

CORNER_ZONES = ("q1", "q2", "q3", "q4")
EDGE_ZONES = ("e_top", "e_right", "e_bottom", "e_left")
AXIS_LABEL_FIELDS = ("matrix_x_from", "matrix_x_to", "matrix_y_from", "matrix_y_to")


class CategoryError(ValueError):
    """An invalid category list (strict mode)."""


def clean_categories(value, mode):
    """Return the normalised category list for ``mode``.

    ``[{"key": <palette key>, "name": {lang: text}}]`` with a full name map per
    entry (empty strings for ``colors``). Raises :class:`CategoryError` with an
    English message on the first problem.
    """
    if mode == CATEGORY_OFF:
        return []
    if mode not in (CATEGORY_COLORS, CATEGORY_NAMED):
        raise CategoryError("Unknown category mode.")
    if value in (None, ""):
        value = []
    if not isinstance(value, list):
        raise CategoryError("Categories must be a list.")
    if len(value) > MATRIX_MAX_CATEGORIES:
        raise CategoryError(f"At most {MATRIX_MAX_CATEGORIES} categories.")
    if len(value) < MATRIX_MIN_CATEGORIES:
        raise CategoryError(f"At least {MATRIX_MIN_CATEGORIES} categories are needed.")
    canonical, langs = seed_langs()
    result, seen = [], set()
    for raw in value:
        if not isinstance(raw, dict):
            raise CategoryError("Invalid category.")
        key = raw.get("key")
        if key not in MATRIX_PALETTE:
            raise CategoryError("Unknown category color.")
        if key in seen:
            raise CategoryError("Each category color may be used only once.")
        seen.add(key)
        if mode == CATEGORY_NAMED:
            name = seed_map(raw.get("name"))
            if not name[canonical]:
                raise CategoryError(
                    "Every category needs a name in the default language."
                )
            if any(len(name[lang]) > MATRIX_NAME_MAX for lang in langs):
                raise CategoryError(
                    f"A category name may have at most {MATRIX_NAME_MAX} characters."
                )
        else:
            name = dict.fromkeys(langs, "")
        result.append({"key": key, "name": name})
    return result


def category_keys(question):
    """Palette keys of the question's categories (empty when mode is off)."""
    if question.matrix_category_mode == CATEGORY_OFF:
        return []
    return [c["key"] for c in question.matrix_categories or []]


def allowed_zones(question):
    """Zones a card may be placed in: the four fields, plus the four axis
    edges when ``matrix_edges``."""
    if question.matrix_edges:
        return (*CORNER_ZONES, *EDGE_ZONES)
    return CORNER_ZONES


def clamp_max_per_person(value):
    """Cards per person from foreign input: 1–100, else the default."""
    if isinstance(value, int) and not isinstance(value, bool) and (
        MATRIX_MIN_MAX_PER_PERSON <= value <= MATRIX_MAX_PER_PERSON_LIMIT
    ):
        return value
    return MATRIX_DEFAULT_MAX_PER_PERSON


def clamp_category_mode(value):
    """Category mode from foreign input: a known mode, else off."""
    return value if value in (CATEGORY_COLORS, CATEGORY_NAMED) else CATEGORY_OFF


def clean_label(value):
    """An axis label as stored: normalised, cut to the column length."""
    return normalize_text(value)[:MATRIX_AXIS_LABEL_MAX].strip()
