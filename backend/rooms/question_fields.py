# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Cleaning rules for question fields shared by the authoring serializer and
the JSON import (``transfer.import_set``), so both accept the same values."""


def clean_evaluation_categories(value):
    """2–5 trimmed, unique (case-insensitive), non-empty labels of at most 40
    characters; anything else falls back to the default verdict scale."""
    from .models import default_verdicts

    cleaned, seen = [], set()
    for raw in value or []:
        label = str(raw).strip()[:40]
        key = label.casefold()
        if label and key not in seen:
            seen.add(key)
            cleaned.append(label)
    return cleaned if 2 <= len(cleaned) <= 5 else default_verdicts()
