# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Pure geometry of the matrix question: zones, hysteresis, clamping and
auto-placement. No database involved."""

from django.test import SimpleTestCase

from . import matrix
from .matrix import (
    EDGES,
    QUADRANTS,
    ZONES,
    auto_place,
    clamp_to_zone,
    resolve_zone,
    zone_at,
)


class ZoneAtTests(SimpleTestCase):
    def test_quadrants_with_and_without_edges(self):
        for edges in (True, False):
            self.assertEqual(zone_at(0.5, 0.5, edges), "q1")
            self.assertEqual(zone_at(-0.5, 0.5, edges), "q2")
            self.assertEqual(zone_at(-0.5, -0.5, edges), "q3")
            self.assertEqual(zone_at(0.5, -0.5, edges), "q4")

    def test_edges_on_axis(self):
        self.assertEqual(zone_at(0.0, 0.5, True), "e_top")
        self.assertEqual(zone_at(0.05, -0.6, True), "e_bottom")
        self.assertEqual(zone_at(0.6, 0.0, True), "e_right")
        self.assertEqual(zone_at(-0.6, 0.1, True), "e_left")

    def test_axis_without_edges_is_deterministic_quadrant(self):
        zone = zone_at(0.0, 0.5, False)
        self.assertIn(zone, {"q1", "q2"})
        self.assertEqual(zone, zone_at(0.0, 0.5, False))

    def test_centre_with_edges_resolves_to_an_edge_deterministically(self):
        zone = zone_at(0.0, 0.0, True)
        self.assertIn(zone, EDGES)
        self.assertEqual(zone, zone_at(0.0, 0.0, True))

    def test_out_of_range_point_is_clipped(self):
        self.assertEqual(zone_at(5, 5, True), "q1")
        self.assertEqual(zone_at(5, 5, False), "q1")


class ResolveZoneTests(SimpleTestCase):
    def test_without_edges_stays_within_hysteresis(self):
        self.assertEqual(resolve_zone("q2", 0.10, 0.5, False), "q2")

    def test_without_edges_leaves_beyond_hysteresis(self):
        self.assertEqual(resolve_zone("q2", 0.13, 0.5, False), "q1")

    def test_with_edges_stays_in_quadrant_near_band(self):
        self.assertEqual(resolve_zone("q1", 0.05, 0.5, True), "q1")

    def test_with_edges_leaves_quadrant_to_edge(self):
        self.assertEqual(resolve_zone("q1", -0.01, 0.5, True), "e_top")

    def test_edge_sticks_within_hysteresis(self):
        self.assertEqual(resolve_zone("e_top", 0.2, 0.5, True), "e_top")

    def test_edge_leaves_beyond_hysteresis(self):
        self.assertEqual(resolve_zone("e_top", 0.25, 0.5, True), "q1")
        self.assertEqual(resolve_zone("e_top", -0.3, 0.5, True), "q2")

    def test_forbidden_current_zone_never_sticks(self):
        # e_top is not allowed without edges, so it cannot be kept.
        self.assertEqual(resolve_zone("e_top", 0.05, 0.5, False), "q1")


class ClampToZoneTests(SimpleTestCase):
    def assertPoint(self, actual, expected):
        self.assertAlmostEqual(actual[0], expected[0])
        self.assertAlmostEqual(actual[1], expected[1])

    def test_quadrant_is_pushed_inside_the_band(self):
        self.assertPoint(clamp_to_zone("q1", -0.5, 0.5, True), (0.12, 0.5))

    def test_top_edge_sits_on_the_vertical_axis(self):
        self.assertPoint(clamp_to_zone("e_top", 0.3, 0.6, True), (0.0, 0.6))

    def test_left_edge_sits_on_the_horizontal_axis(self):
        self.assertPoint(clamp_to_zone("e_left", -0.4, 0.3, True), (-0.4, 0.0))


class AutoPlaceTests(SimpleTestCase):
    def allowed(self):
        for zone in QUADRANTS:
            yield zone, False
            yield zone, True
        for zone in EDGES:
            yield zone, True

    def test_empty_zone_returns_point_inside_zone(self):
        for zone, edges in self.allowed():
            with self.subTest(zone=zone, edges=edges):
                point = auto_place(zone, [], edges)
                self.assertEqual(zone_at(*point, edges), zone)
                self.assertEqual(clamp_to_zone(zone, *point, edges), point)

    def test_occupied_first_slot_yields_a_distinct_point(self):
        for zone, edges in self.allowed():
            with self.subTest(zone=zone, edges=edges):
                first = auto_place(zone, [], edges)
                second = auto_place(zone, [first], edges)
                self.assertNotEqual(first, second)
                self.assertGreaterEqual(
                    ((first[0] - second[0]) ** 2 + (first[1] - second[1]) ** 2) ** 0.5,
                    matrix._MIN_GAP,
                )
                self.assertEqual(zone_at(*second, edges), zone)

    def test_full_zone_returns_one_of_its_slots(self):
        for zone, edges in self.allowed():
            with self.subTest(zone=zone, edges=edges):
                slots = matrix._slots(zone, edges)
                point = auto_place(zone, slots, edges)
                self.assertIn(point, slots)

    def test_is_deterministic(self):
        occupied = [(0.25, 0.85), (0.0, 0.2)]
        for zone in ZONES:
            edges = zone in EDGES
            with self.subTest(zone=zone):
                self.assertEqual(
                    auto_place(zone, occupied, edges),
                    auto_place(zone, occupied, edges),
                )

    def test_every_slot_is_inside_its_zone(self):
        for zone, edges in self.allowed():
            for slot in matrix._slots(zone, edges):
                with self.subTest(zone=zone, edges=edges, slot=slot):
                    self.assertEqual(zone_at(*slot, edges), zone)
                    self.assertEqual(clamp_to_zone(zone, *slot, edges), slot)
