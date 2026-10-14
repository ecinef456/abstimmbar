# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Live geometry of the four-field matrix question.

The board is the square [-1, 1] x [-1, 1] with the origin in the centre.
Each participant card lives at one point ``(x, y)`` of that square; ``x``
grows to the right and ``y`` grows upwards.

Zones
    The board is split into four *quadrants* ``q1`` (top right), ``q2`` (top
    left), ``q3`` (bottom left) and ``q4`` (bottom right). When the question
    has ``matrix_edges`` enabled, four *edge* zones sit on the axes:
    ``e_top``, ``e_right``, ``e_bottom`` and ``e_left``. A band of width
    ``EDGE_BAND`` around both axes is then reserved for the edges, so quadrant
    rectangles start at ``±EDGE_BAND``. Without edges the quadrants cover the
    whole board. Only zones returned by ``rooms.matrix.allowed_zones`` may hold a card.

Hysteresis
    A card that is dragged only slightly across a zone border keeps its zone.
    ``resolve_zone`` keeps the current zone while the point stays within
    ``HYSTERESIS`` of that zone's rectangle.

Clamping and auto-placement
    ``clamp_to_zone`` pulls a point into a zone; edge cards are pinned onto
    their axis. ``auto_place`` picks a deterministic free slot for a new card
    so that cards do not pile up.

The first half of this module is pure geometry; the services that read and
write ``MatrixCard`` rows follow below.
"""
import math

from django.db import transaction

from common.i18n_fields import translated_map
from rooms.matrix import (
    CATEGORY_NAMED,
    CATEGORY_OFF,
    MATRIX_DESCRIPTION_MAX,
    MATRIX_MAX_CARDS,
    MATRIX_TITLE_MAX,
    allowed_zones,
    category_keys,
)
from rooms.mindmap import normalize_text, seed_langs

from .models import MatrixCard, Run

# Collapses bursts of participant writes into one SSE broadcast (as the mind map).
BROADCAST_DEBOUNCE = 1.0

EDGE_BAND = 0.12
HYSTERESIS = 0.12

ZONES = ("q1", "q2", "q3", "q4", "e_top", "e_right", "e_bottom", "e_left")
QUADRANTS = ZONES[:4]
EDGES = ZONES[4:]


def _clip(v):
    return max(-1.0, min(1.0, float(v)))


def zone_rect(zone, edges):
    b = EDGE_BAND if edges else 0.0
    return {
        "q1": (b, 1.0, b, 1.0),
        "q2": (-1.0, -b, b, 1.0),
        "q3": (-1.0, -b, -1.0, -b),
        "q4": (b, 1.0, -1.0, -b),
        "e_top": (-b, b, b, 1.0),
        "e_bottom": (-b, b, -1.0, -b),
        "e_right": (b, 1.0, -b, b),
        "e_left": (-1.0, -b, -b, b),
    }[zone]


def _distance(zone, x, y, edges):
    xmin, xmax, ymin, ymax = zone_rect(zone, edges)
    dx = max(xmin - x, 0.0, x - xmax)
    dy = max(ymin - y, 0.0, y - ymax)
    return (dx * dx + dy * dy) ** 0.5


def _zones(edges):
    return ZONES if edges else QUADRANTS


def zone_at(x, y, edges):
    """The zone whose rectangle contains (x, y); outside all of them (the
    centre square, or a point on an axis without edges) the nearest one, ties
    broken by ZONES order — deterministic."""
    x, y = _clip(x), _clip(y)
    return min(_zones(edges), key=lambda z: (_distance(z, x, y, edges), ZONES.index(z)))


def resolve_zone(current, x, y, edges):
    """Hysteresis: a card stays in ``current`` until it is dragged more than
    HYSTERESIS beyond that zone's rectangle. An unknown/forbidden current
    zone (e.g. an edge after edges were switched off) never sticks."""
    x, y = _clip(x), _clip(y)
    if current in _zones(edges) and _distance(current, x, y, edges) <= HYSTERESIS:
        return current
    return zone_at(x, y, edges)


def clamp_to_zone(zone, x, y, edges):
    xmin, xmax, ymin, ymax = zone_rect(zone, edges)
    if zone in EDGES:  # cards on an edge sit on the axis line
        if zone in ("e_top", "e_bottom"):
            xmin = xmax = 0.0
        else:
            ymin = ymax = 0.0
    return (min(max(_clip(x), xmin), xmax), min(max(_clip(y), ymin), ymax))


_SLOT_DX, _SLOT_DY, _MIN_GAP = 0.3, 0.14, 0.12


def _slots(zone, edges):
    """Candidate centres in a zone, nearest-to-the-centre first for edges and
    row by row from the outer side for quadrants."""
    b = EDGE_BAND if edges else 0.0
    if zone in ("e_top", "e_bottom"):
        sign = 1 if zone == "e_top" else -1
        return [(0.0, sign * (0.2 + i * _SLOT_DY)) for i in range(6)]   # 0.2 … 0.9
    if zone in ("e_left", "e_right"):
        sign = 1 if zone == "e_right" else -1
        return [(sign * (0.25 + i * _SLOT_DX), 0.0) for i in range(3)]  # 0.25, 0.55, 0.85
    sx = 1 if zone in ("q1", "q4") else -1
    sy = 1 if zone in ("q1", "q2") else -1
    xs = (0.25, 0.55, 0.85)
    ys = [0.85 - i * _SLOT_DY for i in range(6)]                        # 0.85 … 0.15
    return [(sx * xv, sy * yv) for yv in ys for xv in xs if xv >= b and yv >= b]


def auto_place(zone, occupied, edges):
    """First slot of the zone farther than _MIN_GAP from every occupied
    position; when the zone is full, the slot with the largest distance to
    its nearest neighbour (cards may overlap slightly). Deterministic."""
    slots = _slots(zone, edges)

    def gap(p):
        return min((((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5 for q in occupied), default=9.0)

    for p in slots:
        if gap(p) > _MIN_GAP:
            return p
    return max(slots, key=gap)


# --- Services: cards, stacks, moderation, payloads ---------------------------


class MatrixError(Exception):
    """A refused action: ``detail`` + HTTP ``status``."""

    def __init__(self, detail, status=400, **extra):
        super().__init__(detail)
        self.detail = detail
        self.status = status
        self.extra = extra

    def body(self):
        return {"detail": self.detail, **self.extra}


def _lock_run(run):
    # Serialises matrix writes per run (limit checks, stack surgery).
    Run.objects.select_for_update(no_key=True).filter(pk=run.pk).first()


def _cards(run, question):
    return MatrixCard.objects.filter(run=run, question=question)


def _get(run, question, card_id):
    card = _cards(run, question).filter(pk=card_id).first() if isinstance(card_id, int) else None
    if card is None:
        raise MatrixError("Card not found.", 404)
    return card


def _top(card):
    return card.stack if card.stack_id else card


def _free_slot(run, question, zone, exclude_pk=None):
    occupied = [
        (x, y)
        for x, y in _cards(run, question)
        .filter(zone=zone, stack__isnull=True)
        .exclude(pk=exclude_pk)
        .values_list("x", "y")
    ]
    return auto_place(zone, occupied, question.matrix_edges)


def _validated(question, zone, title, category, description):
    if zone not in allowed_zones(question):
        raise MatrixError("Zone not allowed.")
    title = normalize_text(title)
    if not title:
        raise MatrixError("Empty title.")
    if len(title) > MATRIX_TITLE_MAX:
        raise MatrixError("Title too long.")
    description = normalize_text(description) if question.matrix_descriptions else ""
    if len(description) > MATRIX_DESCRIPTION_MAX:
        raise MatrixError("Description too long.")
    if question.matrix_category_mode == CATEGORY_OFF:
        category = ""
    elif category not in category_keys(question):
        raise MatrixError("A valid category is required.")
    return title, category, description


def _create(run, question, token, zone, title, category, description, teacher):
    x, y = _free_slot(run, question, zone)
    return MatrixCard.objects.create(
        run=run, question=question, token=token, title=title, description=description,
        category=category, zone=zone, x=x, y=y, teacher=teacher,
    )


def _check_cap(run, question):
    if _cards(run, question).count() >= MATRIX_MAX_CARDS:
        raise MatrixError("Card limit reached.", 409)


def add_card(run, question, token, zone, title, category="", description=""):
    title, category, description = _validated(question, zone, title, category, description)
    with transaction.atomic():
        _lock_run(run)
        _check_cap(run, question)
        if _cards(run, question).filter(token=token).count() >= question.matrix_max_per_person:
            raise MatrixError("Card limit reached.", 409)
        return _create(run, question, token, zone, title, category, description, False)


def add_teacher_card(run, question, zone, title, category="", description=""):
    title, category, description = _validated(question, zone, title, category, description)
    with transaction.atomic():
        _lock_run(run)
        if run.phase == Run.Phase.FINISHED:
            raise MatrixError("The run is finished.", 409)
        _check_cap(run, question)
        return _create(run, question, None, zone, title, category, description, True)


def _detach(card):
    """Take ``card`` out of its stack. A member just leaves; a top with
    members hands its position and its members to the oldest member. A card
    leaving (or promoted out of) a hidden top stays hidden — moderation must
    not silently re-expose it."""
    with transaction.atomic():
        if card.stack_id:
            if card.stack.hidden:
                card.hidden = True
            card.stack = None
            card.save(update_fields=["stack", "hidden"])
            return
        members = list(card.members.order_by("created_at", "pk"))
        if not members:
            return
        new_top, rest = members[0], members[1:]
        new_top.stack = None
        new_top.x, new_top.y, new_top.zone, new_top.placed = card.x, card.y, card.zone, card.placed
        new_top.hidden = new_top.hidden or card.hidden
        new_top.save(update_fields=["stack", "x", "y", "zone", "placed", "hidden"])
        MatrixCard.objects.filter(pk__in=[m.pk for m in rest]).update(stack=new_top)


def remove_card(run, question, token, card_id):
    with transaction.atomic():
        _lock_run(run)
        card = _get(run, question, card_id)
        if card.token_id is None or card.token_id != token.pk:
            raise MatrixError("Card not found.", 404)
        _detach(card)
        card.delete()


def delete_teacher_card(run, question, card_id):
    with transaction.atomic():
        _lock_run(run)
        card = _get(run, question, card_id)
        if not card.teacher:
            raise MatrixError("Card not found.", 404)
        _detach(card)
        card.delete()


def move_card(run, question, card_id, x, y):
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError) as error:
        raise MatrixError("Invalid position.") from error
    if not (math.isfinite(x) and math.isfinite(y)):
        raise MatrixError("Invalid position.")
    with transaction.atomic():
        _lock_run(run)
        top = _top(_get(run, question, card_id))
        edges = question.matrix_edges
        top.zone = resolve_zone(top.zone, x, y, edges)
        top.x, top.y = clamp_to_zone(top.zone, x, y, edges)
        top.placed = True
        top.save(update_fields=["zone", "x", "y", "placed"])
        # Members carry the top's zone and position (spec: the top's values
        # count) — keep the stored rows consistent.
        top.members.update(zone=top.zone, x=top.x, y=top.y)
        return top


def stack_card(run, question, card_id, onto_id):
    with transaction.atomic():
        _lock_run(run)
        moving = _top(_get(run, question, card_id))
        target = _top(_get(run, question, onto_id))
        if moving.pk == target.pk:
            raise MatrixError("Cannot stack a card onto itself.")
        # The whole moving stack takes the target's zone and position; the
        # members of a hidden top become hidden too.
        place = {"stack": target, "zone": target.zone, "x": target.x, "y": target.y}
        if moving.hidden:
            moving.members.update(hidden=True)
        moving.members.update(**place)
        moving.stack = target
        moving.zone, moving.x, moving.y = target.zone, target.x, target.y
        moving.save(update_fields=["stack", "zone", "x", "y"])
        return target


def unstack_card(run, question, card_id):
    with transaction.atomic():
        _lock_run(run)
        card = _get(run, question, card_id)
        if card.stack_id:
            card.zone = card.stack.zone
        elif not card.members.exists():
            raise MatrixError("Card is not stacked.")
        _detach(card)
        card.x, card.y = _free_slot(run, question, card.zone, exclude_pk=card.pk)
        card.placed = False
        card.save(update_fields=["x", "y", "zone", "placed"])
        return card


def set_hidden(run, question, card_id, hidden):
    with transaction.atomic():
        _lock_run(run)
        card = _get(run, question, card_id)
        card.hidden = bool(hidden)
        card.save(update_fields=["hidden"])
        return card


def own_card_ids(run, question, token):
    return list(_cards(run, question).filter(token=token).values_list("pk", flat=True))


def mine_payload(run, question, token):
    return [
        {"id": c.pk, "title": c.title, "description": c.description,
         "category": c.category, "zone": c.zone}
        for c in _cards(run, question).filter(token=token)
    ]


def card_count(run, question):
    return _cards(run, question).count()


def contributor_count(run, question):
    return (
        _cards(run, question).filter(token__isnull=False).values("token").distinct().count()
    )


def board_payload(run, question, presenter):
    """The whole board (``cards``, ``count``, ``contributors``; settings live
    in :func:`settings_payload`). ``presenter=False`` drops hidden cards and
    the members of a hidden top; ``presenter=True`` marks them (``hidden``)."""
    rows = list(_cards(run, question))
    hidden_ids = {c.pk for c in rows if c.hidden}
    cards = []
    for c in rows:
        if not presenter and (c.hidden or (c.stack_id and c.stack_id in hidden_ids)):
            continue
        cards.append({
            "id": c.pk, "title": c.title, "description": c.description,
            "category": c.category, "zone": c.zone, "x": c.x, "y": c.y,
            "stack": c.stack_id, "hidden": c.hidden, "teacher": c.teacher,
            "placed": c.placed,
        })
    return {
        "cards": cards,
        "count": sum(1 for c in cards if not c["hidden"]),
        "contributors": contributor_count(run, question),
    }


def csv_rows(run, question):
    """One dict per VISIBLE card for the results CSV (hidden cards and the
    members of a hidden top are left out, like the participant board):
    ``title, description, category, zone, x, y, stack`` (``stack`` = title of
    the stack's top card for members, else empty)."""
    canonical = seed_langs()[0]
    names = {
        c["key"]: (c.get("name") or {}).get(canonical, "") or c["key"]
        for c in question.matrix_categories or []
    }
    rows = list(_cards(run, question))
    titles = {c.pk: c.title for c in rows}
    hidden_ids = {c.pk for c in rows if c.hidden}
    result = []
    for c in rows:
        if c.hidden or (c.stack_id and c.stack_id in hidden_ids):
            continue
        if question.matrix_category_mode == CATEGORY_OFF:
            category = ""
        elif question.matrix_category_mode == CATEGORY_NAMED:
            category = names.get(c.category, c.category)
        else:
            category = c.category
        result.append({
            "title": c.title, "description": c.description, "category": category,
            "zone": c.zone, "x": f"{c.x:.2f}", "y": f"{c.y:.2f}",
            "stack": titles.get(c.stack_id, "") if c.stack_id else "",
        })
    return result


def settings_payload(question):
    """What a participant device needs to render the matrix (no cards):
    zones, flags, categories and the four axis labels as ``{de, en}`` maps."""
    return {
        "zones": list(allowed_zones(question)),
        "edges": question.matrix_edges,
        "descriptions": question.matrix_descriptions,
        "max_per_person": question.matrix_max_per_person,
        "category_mode": question.matrix_category_mode,
        "categories": [
            {"key": c["key"], "name": c.get("name") or {}}
            for c in question.matrix_categories or []
        ],
        "axes": {
            "x_from": translated_map(question, "matrix_x_from"),
            "x_to": translated_map(question, "matrix_x_to"),
            "y_from": translated_map(question, "matrix_y_from"),
            "y_to": translated_map(question, "matrix_y_to"),
        },
    }
