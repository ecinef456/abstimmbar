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
    whole board. Only zones returned by ``allowed_zones`` may hold a card.

Hysteresis
    A card that is dragged only slightly across a zone border keeps its zone.
    ``resolve_zone`` keeps the current zone while the point stays within
    ``HYSTERESIS`` of that zone's rectangle.

Clamping and auto-placement
    ``clamp_to_zone`` pulls a point into a zone; edge cards are pinned onto
    their axis. ``auto_place`` picks a deterministic free slot for a new card
    so that cards do not pile up.

This module holds the pure geometry only. Services that read and write
the database follow in the same module.
"""

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
