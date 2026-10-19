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
from collections import Counter
from datetime import datetime

from django.core import signing
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

from .models import MatrixCard, MatrixPhase, Run

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


def is_rating(run, question):
    """True while the question is in its rating stage in this run (see
    ``live.matrix_rating``): a rating mode is set and the stored stage is
    "rate". Collecting and stack surgery are then locked."""
    return bool(question.matrix_rating_mode) and MatrixPhase.objects.filter(
        run=run, question=question, stage=MatrixPhase.Stage.RATE
    ).exists()


COLLECTING_PAUSED = "Collecting is paused while rating."
STACKS_LOCKED = "Stacks are locked while rating."


def _lock_collecting(run, question):
    if is_rating(run, question):
        raise MatrixError(COLLECTING_PAUSED, 409)


def _lock_stacks(run, question):
    if is_rating(run, question):
        raise MatrixError(STACKS_LOCKED, 409)


def _cards(run, question):
    return MatrixCard.objects.filter(run=run, question=question)


def _get(run, question, card_id):
    card = _cards(run, question).filter(pk=card_id).first() if isinstance(card_id, int) else None
    if card is None:
        raise MatrixError("Card not found.", 404)
    return card


def _top(card):
    return card.stack if card.stack_id else card


def free_slot(run, question, zone, exclude_pk=None):
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
    x, y = free_slot(run, question, zone)
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
        _lock_collecting(run, question)
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


def _disposable_summary(card):
    """A summary card that may be deleted when it no longer tops a stack:
    one with ratings is kept (the ratings must not vanish)."""
    return card.summary and not card.ratings.exists()


def _detach(card):
    """Take ``card`` out of its stack. A member just leaves; a top with
    members hands its position and its members to the oldest member. A card
    leaving (or promoted out of) a hidden top stays hidden — moderation must
    not silently re-expose it. A summary top (AI grouping) whose last member
    leaves is deleted — it only summarises its stack — unless it has ratings
    (then it stays as a single card)."""
    with transaction.atomic():
        if card.stack_id:
            top = card.stack
            if top.hidden:
                card.hidden = True
            card.stack = None
            card.save(update_fields=["stack", "hidden"])
            if _disposable_summary(top) and not top.members.exists():
                top.delete()
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
        _lock_collecting(run, question)
        card = _get(run, question, card_id)
        if card.token_id is None or card.token_id != token.pk:
            raise MatrixError("Card not found.", 404)
        _detach(card)
        card.delete()


def delete_teacher_card(run, question, card_id):
    with transaction.atomic():
        _lock_run(run)
        _lock_stacks(run, question)
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
        _lock_stacks(run, question)
        moving = _top(_get(run, question, card_id))
        target = _top(_get(run, question, onto_id))
        if moving.pk == target.pk:
            raise MatrixError("Cannot stack a card onto itself.")
        if target.hidden:
            raise MatrixError("Cannot stack onto a hidden card.")
        # The whole moving stack takes the target's zone and position; the
        # members of a hidden top become hidden too.
        place = {"stack": target, "zone": target.zone, "x": target.x, "y": target.y}
        if moving.hidden:
            moving.members.update(hidden=True)
        moving.members.update(**place)
        moving.stack = target
        moving.zone, moving.x, moving.y = target.zone, target.x, target.y
        # An unrated summary card under another card summarises nothing any
        # more; a rated one keeps its flag (and its ratings).
        if _disposable_summary(moving):
            moving.summary = False
        moving.save(update_fields=["stack", "zone", "x", "y", "summary"])
        return target


def unstack_card(run, question, card_id):
    with transaction.atomic():
        _lock_run(run)
        _lock_stacks(run, question)
        card = _get(run, question, card_id)
        if card.stack_id:
            card.zone = card.stack.zone
        elif not card.members.exists():
            raise MatrixError("Card is not stacked.")
        _detach(card)
        if _disposable_summary(card):
            # A summary top taken off its stack summarises nothing any more.
            card.delete()
            return None
        card.x, card.y = free_slot(run, question, card.zone, exclude_pk=card.pk)
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


def participant_card_total(run):
    """Participant-added matrix cards of the whole run (teacher cards are the
    presenter's own and not an answer) — part of the run's ``votes_total``."""
    return MatrixCard.objects.filter(run=run, token__isnull=False).count()


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
            "placed": c.placed, "summary": c.summary,
        })
    return {
        "cards": cards,
        # Members of a hidden top are hidden with it (they stay in the owner's
        # payload, flagged only on the top), so they do not count either.
        "count": sum(
            1 for c in cards
            if not c["hidden"] and not (c["stack"] and c["stack"] in hidden_ids)
        ),
        "contributors": contributor_count(run, question),
    }


def csv_rows(run, question):
    """One dict per VISIBLE card for the results CSV (hidden cards and the
    members of a hidden top are left out, like the participant board):
    ``id, title, description, category, zone, x, y, stack`` (``stack`` = title of
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
            "id": c.pk, "title": c.title, "description": c.description, "category": category,
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


# --- AI grouping: proposal simulation and signing ---------------------------
#
# ``live.ai_matrix`` builds the prompt and parses the reply into groups (cards
# of one field that belong together, topped by a new summary card) and hints
# (same content in different fields; display only). ``simulate_groups``
# checks every group against the live board and previews the summary card;
# the parsed proposal travels to the client signed (``sign_proposal``) so
# apply can re-check it without trusting the client.

PROPOSAL_SALT = "matrix-ai-proposal"
PROPOSAL_MAX_AGE = 24 * 60 * 60  # seconds

SKIP_UNKNOWN = "unknown"      # card deleted / never on this board
SKIP_HIDDEN = "hidden"        # card (or its top) hidden
SKIP_ZONES = "zones"          # cards in different fields
SKIP_DUPLICATE = "duplicate"  # a card already belongs to an earlier group
SKIP_TOO_FEW = "too_few"      # fewer than two distinct tops
SKIP_CHANGED = "changed"      # the group's stacks differ from the proposal's


def _age(card):
    return (card.created_at, card.pk)


def _board(run, question):
    """``(cards by id, members by top id)`` of the run's board."""
    rows = list(_cards(run, question))
    members = {}
    for c in rows:
        if c.stack_id:
            members.setdefault(c.stack_id, []).append(c)
    return {c.pk: c for c in rows}, members


def _resolve_top(card, by_id):
    """The visible top of ``card`` or a skip reason."""
    if card is None:
        return None, SKIP_UNKNOWN
    top = by_id.get(card.stack_id) if card.stack_id else card
    if top is None:
        return None, SKIP_UNKNOWN
    if card.hidden or top.hidden:
        return None, SKIP_HIDDEN
    return top, None


def _group_category(question, cards):
    """Most frequent valid category of ``cards``; tie -> the oldest card's;
    "" when categories are off. Falls back to the first category."""
    keys = category_keys(question)
    if not keys:
        return ""
    counts = Counter(c.category for c in cards if c.category in keys)
    if not counts:
        return keys[0]
    best = max(counts.values())
    tied = {key for key, n in counts.items() if n == best}
    return min((c for c in cards if c.category in tied), key=_age).category


def _card_preview(card):
    return {"id": card.pk, "title": card.title, "category": card.category}


def simulate_groups(run, question, groups):
    """Check the parsed ``groups`` (``ai_matrix.parse_reply``) against the
    board; one preview dict per group in order: ``{index, status ("ok" |
    "skip"), skip_reason?, zone, cards [{id, title, category}] (the distinct
    tops), title, description, reason, top_summary_id?, category, anchor_id,
    x, y, placed}`` (``anchor_id`` = the card whose position/``placed`` the
    summary card takes).
    Member ids map to their top. A group is skipped when a card is unknown or
    hidden, its tops lie in different zones, a top is already in an earlier
    ok group, or it has fewer than two distinct tops. An existing summary top
    in the group is kept (its title/description/category/position); else the
    new summary card takes the oldest top's position and the most frequent
    category of all cards incl. stack members (tie: the oldest card's)."""
    by_id, members = _board(run, question)
    used = set()
    result = []
    for group in groups:
        tops, reason = [], None
        for card_id in group["cards"]:
            top, reason = _resolve_top(by_id.get(card_id), by_id)
            if reason:
                break
            if top not in tops:
                tops.append(top)
        preview = {
            "index": group["index"],
            "status": "ok",
            "zone": tops[0].zone if tops else None,
            "cards": [_card_preview(t) for t in tops],
            "title": group["title"],
            "description": group.get("description", "") if question.matrix_descriptions else "",
            "reason": group.get("reason", ""),
        }
        if not reason:
            if len({t.zone for t in tops}) > 1:
                reason = SKIP_ZONES
            elif any(t.pk in used for t in tops):
                reason = SKIP_DUPLICATE
            elif len(tops) < 2:
                reason = SKIP_TOO_FEW
        if reason:
            preview.update(status="skip", skip_reason=reason)
            result.append(preview)
            continue
        used.update(t.pk for t in tops)
        everyone = [
            *tops,
            *(m for t in tops for m in members.get(t.pk, []) if not m.hidden),
        ]
        summaries = [t for t in tops if t.summary]
        if summaries:
            anchor = min(summaries, key=_age)
            preview.update(
                top_summary_id=anchor.pk, title=anchor.title,
                description=anchor.description, category=anchor.category,
            )
        else:
            anchor = min(tops, key=_age)
            preview["category"] = _group_category(question, everyone)
        preview.update(anchor_id=anchor.pk, x=anchor.x, y=anchor.y, placed=anchor.placed)
        result.append(preview)
    return result


def simulate_hints(run, question, hints):
    """The parsed ``hints`` with only valid ids (existing, visible; members
    map to their top, duplicates dropped): ``{index, cards [{id, title,
    category, zone}], reason}``. Hints whose cards no longer span at least
    two zones are dropped."""
    by_id, _ = _board(run, question)
    result = []
    for hint in hints:
        tops = []
        for card_id in hint["cards"]:
            top, reason = _resolve_top(by_id.get(card_id), by_id)
            if not reason and top not in tops:
                tops.append(top)
        if len({t.zone for t in tops}) < 2:
            continue
        result.append({
            "index": hint["index"],
            "cards": [{**_card_preview(t), "zone": t.zone} for t in tops],
            "reason": hint.get("reason", ""),
        })
    return result


def with_tops(groups, previews):
    """The parsed ``groups`` with the tops they resolved to at propose time
    (``tops``), so apply can tell when a stack changed in between."""
    return [
        {**group, "tops": [c["id"] for c in preview["cards"]]}
        for group, preview in zip(groups, previews, strict=True)
    ]


def sign_proposal(run, question, groups, hints, malformed=0):
    """Signed (not encrypted) parsed proposal for ai-apply, bound to run +
    question, valid for PROPOSAL_MAX_AGE."""
    return signing.dumps(
        {"run": run.pk, "question": question.pk, "groups": groups, "hints": hints,
         "malformed": malformed},
        salt=PROPOSAL_SALT, compress=True,
    )


def unsign_proposal(run, question, blob):
    """``(groups, hints, malformed)`` of a signed proposal; MatrixError 400
    when tampered or made for another run/question, 409 when expired."""
    if not isinstance(blob, str):
        raise MatrixError("Invalid proposal.")
    try:
        data = signing.loads(blob, salt=PROPOSAL_SALT, max_age=PROPOSAL_MAX_AGE)
    except signing.SignatureExpired as error:
        raise MatrixError("This proposal has expired.", 409) from error
    except signing.BadSignature as error:
        raise MatrixError("Invalid proposal.") from error
    if (
        not isinstance(data, dict)
        or data.get("run") != run.pk
        or data.get("question") != question.pk
    ):
        raise MatrixError("Invalid proposal.")
    return data.get("groups", []), data.get("hints", []), data.get("malformed", 0)


# --- AI grouping: apply and undo --------------------------------------------
#
# ``apply_groups`` re-checks the selected groups against the live board (via
# ``simulate_groups``) under the run lock and stacks each ok group under its
# summary card in one transaction. The signed ``undo`` describes per applied
# group the summary top, whether it was created, its members right after the
# apply, every touched card's previous stack/zone/position and the summary
# cards deleted on the way (a second, unrated summary of the group);
# ``undo_groups`` restores exactly that or refuses (409) when a stack changed.

UNDO_SALT = "matrix-ai-undo"
UNDO_MAX_AGE = PROPOSAL_MAX_AGE
UNDO_CHANGED = "Der Stapel wurde inzwischen verändert – Rückgängig ist nicht mehr möglich."
SKIP_LIMIT = "limit"  # card limit reached, no room for a summary card


def _ai_edit(question, edit):
    """``(title, description, category)`` of one presenter edit, None where
    not given (or, for the category, not a valid key); MatrixError (400) for
    an empty/too long title or a too long description."""
    title = description = None
    if edit.get("title") is not None:
        title = normalize_text(edit["title"])
        if not title:
            raise MatrixError("Empty title.")
        if len(title) > MATRIX_TITLE_MAX:
            raise MatrixError("Title too long.")
    if edit.get("description") is not None and question.matrix_descriptions:
        description = normalize_text(edit["description"])
        if len(description) > MATRIX_DESCRIPTION_MAX:
            raise MatrixError("Description too long.")
    category = edit.get("category")
    if category not in category_keys(question):
        category = None
    return title, description, category


def _snapshot(card):
    return {
        "id": card.pk, "title": card.title, "description": card.description,
        "category": card.category, "zone": card.zone, "x": card.x, "y": card.y,
        "placed": card.placed, "hidden": card.hidden,
        "created_at": card.created_at.isoformat(),
    }


def _apply_group(run, question, preview, edit):
    """Stack one ok group (a ``simulate_groups`` preview) under its summary
    card; returns the group's undo entry."""
    title, description, category = edit
    tops = list(_cards(run, question).filter(pk__in=[c["id"] for c in preview["cards"]]))
    keep = preview.get("top_summary_id")
    if keep:
        top = next(t for t in tops if t.pk == keep)
    else:
        top = MatrixCard.objects.create(
            run=run, question=question, token=None, teacher=True, summary=True,
            zone=preview["zone"], x=preview["x"], y=preview["y"],
            placed=preview["placed"], title=title or preview["title"],
            description=(
                (preview["description"] if description is None else description)
                if question.matrix_descriptions else ""
            ),
            category=category or preview["category"],
        )
    touched, deleted = [], []
    place = {"zone": top.zone, "x": top.x, "y": top.y}
    for other in tops:
        if other.pk == top.pk:
            continue
        for member in other.members.all():
            touched.append([member.pk, member.stack_id, member.zone, member.x, member.y])
        other.members.update(stack=top, **place)
        if _disposable_summary(other):
            deleted.append(_snapshot(other))
            other.delete()
            continue
        touched.append([other.pk, other.stack_id, other.zone, other.x, other.y])
        other.stack = top
        other.zone, other.x, other.y = top.zone, top.x, top.y
        other.save(update_fields=["stack", "zone", "x", "y"])
    return {
        "top": top.pk,
        "created": not keep,
        "members": sorted(top.members.values_list("pk", flat=True)),
        "cards": touched,
        "deleted": deleted,
    }


def apply_groups(run, question, groups, selected, edits):
    """Apply the ``selected`` groups (indices) of a proposal in one
    transaction under the run lock: re-simulate against the live board,
    create (or keep an existing) summary top per ok group and stack every
    other card/stack of the group under it. A group whose resolved tops
    differ from the ``tops`` recorded at propose time (``with_tops``) is
    skipped ("changed") — apply never pulls in unreviewed stacks. ``edits``: ``{index: {title?,
    description?, category?}}`` for the new summary cards (title validated
    like a presenter card — 400; an invalid category falls back to the
    proposal's; edits of a group that keeps an existing summary top are
    ignored). Refused while rating (409); allowed on a finished run, like
    the mind map's ai-apply and manual stack moderation. Returns
    ``{applied: [index], skipped: [{index, reason}], undo}``."""
    chosen = sorted(set(selected))
    by_index = {g["index"]: g for g in groups}
    with transaction.atomic():
        _lock_run(run)
        _lock_stacks(run, question)
        previews = simulate_groups(run, question, [by_index[i] for i in chosen if i in by_index])
        count = _cards(run, question).count()
        applied, skipped, undo = [], [], []
        for preview in previews:
            index = preview["index"]
            reason = preview.get("skip_reason")
            signed = by_index[index].get("tops")
            if not reason and signed is not None and (
                {c["id"] for c in preview["cards"]} != set(signed)
            ):
                # E.g. a card was stacked into an unreviewed stack since.
                reason = SKIP_CHANGED
            if not reason and "top_summary_id" not in preview and count >= MATRIX_MAX_CARDS:
                reason = SKIP_LIMIT
            if reason:
                skipped.append({"index": index, "reason": reason})
                continue
            edit = (
                (None, None, None) if "top_summary_id" in preview
                else _ai_edit(question, edits.get(index) or {})
            )
            entry = _apply_group(run, question, preview, edit)
            count += int(entry["created"]) - len(entry["deleted"])
            applied.append(index)
            undo.append(entry)
    blob = signing.dumps(
        {"run": run.pk, "question": question.pk, "groups": undo},
        salt=UNDO_SALT, compress=True,
    )
    return {"applied": applied, "skipped": skipped, "undo": blob}


def _unsign_undo(run, question, blob):
    if not isinstance(blob, str):
        raise MatrixError("Invalid undo data.")
    try:
        data = signing.loads(blob, salt=UNDO_SALT, max_age=UNDO_MAX_AGE)
    except signing.SignatureExpired as error:
        raise MatrixError("This undo step has expired.", 409) from error
    except signing.BadSignature as error:
        raise MatrixError("Invalid undo data.") from error
    if (
        not isinstance(data, dict)
        or data.get("run") != run.pk
        or data.get("question") != question.pk
        or not isinstance(data.get("groups"), list)
    ):
        raise MatrixError("Invalid undo data.")
    return data["groups"]


def undo_groups(run, question, blob):
    """Undo one ``apply_groups`` step exactly: restore every touched card's
    stack/zone/position, recreate deleted summary cards and delete the
    created ones. 409 (nothing changed) when a summary top is gone, no
    longer a top, has other members than right after the apply, or a
    created one got ratings meanwhile."""
    groups = _unsign_undo(run, question, blob)
    with transaction.atomic():
        _lock_run(run)
        _lock_stacks(run, question)
        rows = {c.pk: c for c in _cards(run, question)}
        members = {}
        for c in rows.values():
            if c.stack_id:
                members.setdefault(c.stack_id, set()).add(c.pk)
        for group in groups:
            top = rows.get(group["top"])
            if (
                top is None
                or top.stack_id
                or members.get(top.pk, set()) != set(group["members"])
                or (group["created"] and top.ratings.exists())
            ):
                raise MatrixError(UNDO_CHANGED, 409)
        net = sum(len(g["deleted"]) - int(g["created"]) for g in groups)
        if net > 0 and len(rows) + net > MATRIX_MAX_CARDS:
            raise MatrixError("Card limit reached.", 409)
        for group in reversed(groups):
            ids = {}
            for snap in group["deleted"]:
                card = MatrixCard.objects.create(
                    run=run, question=question, token=None, teacher=True, summary=True,
                    **{k: snap[k] for k in (
                        "title", "description", "category", "zone", "x", "y", "placed", "hidden",
                    )},
                )
                MatrixCard.objects.filter(pk=card.pk).update(
                    created_at=datetime.fromisoformat(snap["created_at"])
                )
                ids[snap["id"]] = card.pk
            for pk, stack, zone, x, y in group["cards"]:
                MatrixCard.objects.filter(pk=pk).update(
                    stack_id=ids.get(stack, stack), zone=zone, x=x, y=y
                )
            if group["created"]:
                MatrixCard.objects.filter(pk=group["top"]).delete()
