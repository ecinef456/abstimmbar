#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Draw the game-mode avatars: 30 cartoon physicists, one SVG each.

    python3 fork/avatars/generate.py

writes backend/quizbar/static/quizbar/avatars/<slug>.svg and the list in
backend/quizbar/avatar_list.py (your own PNGs in that folder override or
extend these, see its README.md). Every avatar is assembled from simple parts
(face, hair, beard, glasses, clothes, a prop or two) on a 100×100 canvas.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "backend/quizbar/static/quizbar/avatars"
LIST = ROOT / "backend/quizbar/avatar_list.py"

SKIN = {
    "light": "#f6d5bf",
    "fair": "#efc5a8",
    "medium": "#e0ab84",
    "tan": "#c98f63",
    "brown": "#9c6644",
}
HAIR = {
    "white": "#f4f4f2",
    "grey": "#b9bcc0",
    "black": "#26201e",
    "dark": "#3d2b22",
    "brown": "#6b4430",
    "auburn": "#8a4b2a",
    "blond": "#d9b25f",
}
INK = "#1f2328"

# -- parts -------------------------------------------------------------------


def background(color, extra=""):
    return f'<circle cx="50" cy="50" r="50" fill="{color}"/>{extra}'


def body(color, collar=""):
    return (
        f'<path d="M12 104 C14 84 30 77 50 77 C70 77 86 84 88 104 Z" fill="{color}"/>'
        + collar
    )


def neck(skin):
    return f'<path d="M43 66 L43 79 Q50 83 57 79 L57 66 Z" fill="{skin}"/>' \
           f'<path d="M43 74 Q50 78 57 74" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="2"/>'


def face(skin):
    return (
        f'<circle cx="31.5" cy="53" r="4.6" fill="{skin}"/><circle cx="68.5" cy="53" r="4.6" fill="{skin}"/>'
        f'<ellipse cx="50" cy="52" rx="18.5" ry="21" fill="{skin}"/>'
        '<ellipse cx="41" cy="60" rx="3.2" ry="1.9" fill="#e8846f" opacity=".28"/>'
        '<ellipse cx="59" cy="60" rx="3.2" ry="1.9" fill="#e8846f" opacity=".28"/>'
        f'<path d="M49 52 Q47.5 57 50 58.2" fill="none" stroke="{INK}" stroke-opacity=".45" stroke-width="1.3" stroke-linecap="round"/>'
    )


def eyes(kind="dots", brow=INK, brow_tilt=0):
    t = brow_tilt
    brows = (
        f'<path d="M37.5 {45.5 - t} Q42 {43.5 - t} 46 {45 + t / 2}" fill="none" stroke="{brow}" stroke-width="2" stroke-linecap="round"/>'
        f'<path d="M54 {45 + t / 2} Q58 {43.5 - t} 62.5 {45.5 - t}" fill="none" stroke="{brow}" stroke-width="2" stroke-linecap="round"/>'
    )
    if kind == "closed":
        return brows + (
            f'<path d="M39 51 Q42 53 45 51" fill="none" stroke="{INK}" stroke-width="1.7" stroke-linecap="round"/>'
            f'<path d="M55 51 Q58 53 61 51" fill="none" stroke="{INK}" stroke-width="1.7" stroke-linecap="round"/>'
        )
    if kind == "wink":
        return brows + (
            f'<circle cx="42" cy="51" r="2.3" fill="{INK}"/><circle cx="42.8" cy="50.3" r=".7" fill="#fff"/>'
            f'<path d="M55 51.5 Q58 49.5 61 51.5" fill="none" stroke="{INK}" stroke-width="1.8" stroke-linecap="round"/>'
        )
    return brows + (
        f'<circle cx="42" cy="51" r="2.3" fill="{INK}"/><circle cx="58" cy="51" r="2.3" fill="{INK}"/>'
        '<circle cx="42.8" cy="50.3" r=".7" fill="#fff"/><circle cx="58.8" cy="50.3" r=".7" fill="#fff"/>'
    )


def mouth(kind="smile"):
    if kind == "grin":
        return f'<path d="M43 61 Q50 69 57 61 Z" fill="{INK}"/><path d="M45 62 Q50 64.5 55 62" fill="#fff"/>'
    if kind == "smirk":
        return f'<path d="M45 62.5 Q51 64.5 56 60.5" fill="none" stroke="{INK}" stroke-width="1.8" stroke-linecap="round"/>'
    if kind == "o":
        return f'<ellipse cx="50" cy="63" rx="2.6" ry="3.2" fill="{INK}"/>'
    if kind == "tongue":
        return (
            f'<path d="M43.5 61 Q50 66 56.5 61 Z" fill="{INK}"/>'
            '<path d="M47 62.5 Q47 70 50 70 Q53 70 53 62.5 Z" fill="#e05a6b"/>'
            '<path d="M50 63 L50 68" stroke="#b8384a" stroke-width=".8"/>'
        )
    return f'<path d="M44 61 Q50 66.5 56 61" fill="none" stroke="{INK}" stroke-width="1.9" stroke-linecap="round"/>'


def sunglasses(color="#111", frame="#111"):
    return (
        f'<path d="M35 47 H47 Q48 47 47.6 49 L46.6 54 Q46 57 42.5 57 H39 Q35.5 57 35 54 L34.4 49 Q34.2 47 35 47 Z" fill="{color}" stroke="{frame}" stroke-width="1"/>'
        f'<path d="M53 47 H65 Q65.8 47 65.6 49 L65 54 Q64.5 57 61 57 H57.5 Q54 57 53.4 54 L52.4 49 Q52 47 53 47 Z" fill="{color}" stroke="{frame}" stroke-width="1"/>'
        f'<path d="M47.4 49 Q50 47.6 52.6 49" fill="none" stroke="{frame}" stroke-width="1.6"/>'
        '<path d="M37 49.5 L41 49.5" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round"/>'
        '<path d="M55 49.5 L59 49.5" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round"/>'
        f'<path d="M34.6 49 L31 48.5 M65.4 49 L69 48.5" stroke="{frame}" stroke-width="1.4"/>'
    )


def round_glasses(color="#3b3b3b", r=5.6):
    return (
        f'<circle cx="42" cy="51" r="{r}" fill="#fff" fill-opacity=".18" stroke="{color}" stroke-width="1.5"/>'
        f'<circle cx="58" cy="51" r="{r}" fill="#fff" fill-opacity=".18" stroke="{color}" stroke-width="1.5"/>'
        f'<path d="M{42 + r} 50.5 Q50 48.5 {58 - r} 50.5" fill="none" stroke="{color}" stroke-width="1.4"/>'
        f'<path d="M{42 - r} 50.5 L31.5 49.5 M{58 + r} 50.5 L68.5 49.5" stroke="{color}" stroke-width="1.3"/>'
    )


def square_glasses(color="#222"):
    return (
        f'<rect x="35.5" y="46.5" width="13" height="9" rx="2.5" fill="#fff" fill-opacity=".15" stroke="{color}" stroke-width="1.8"/>'
        f'<rect x="51.5" y="46.5" width="13" height="9" rx="2.5" fill="#fff" fill-opacity=".15" stroke="{color}" stroke-width="1.8"/>'
        f'<path d="M48.5 50 Q50 48.8 51.5 50" fill="none" stroke="{color}" stroke-width="1.6"/>'
    )


def mustache(kind, color):
    if kind == "walrus":
        return f'<path d="M38.5 60 Q41 55.5 50 57.5 Q59 55.5 61.5 60 Q60.5 63.5 56 61.5 Q50 60 44 61.5 Q39.5 63.5 38.5 60 Z" fill="{color}"/>'
    if kind == "thin":
        return f'<path d="M42 58.6 Q46 56.6 50 58 Q54 56.6 58 58.6 Q54 59.6 50 59 Q46 59.6 42 58.6 Z" fill="{color}"/>'
    if kind == "curl":
        return (
            f'<path d="M50 58 Q45 56 41 58.5 Q38.5 58 38 55.5 Q38.5 60.5 43 60.3 Q47 60 50 59 Q53 60 57 60.3 Q61.5 60.5 62 55.5 Q61.5 58 59 58.5 Q55 56 50 58 Z" fill="{color}"/>'
        )
    return f'<path d="M41 59.5 Q45 56 50 57.8 Q55 56 59 59.5 Q55 61 50 59.6 Q45 61 41 59.5 Z" fill="{color}"/>'


def beard(kind, color):
    if kind == "full":
        return (
            f'<path d="M31.8 52 Q31 72 50 80 Q69 72 68.2 52 Q66 63 60 64 Q55 60.5 50 61.5 Q45 60.5 40 64 Q34 63 31.8 52 Z" fill="{color}"/>'
        )
    if kind == "big":
        return (
            f'<path d="M30.5 50 Q27 78 50 88 Q73 78 69.5 50 Q67 64 60 65 Q55 61 50 62 Q45 61 40 65 Q33 64 30.5 50 Z" fill="{color}"/>'
        )
    if kind == "goatee":
        return f'<path d="M44.5 65 Q50 75 55.5 65 Q50 67.5 44.5 65 Z" fill="{color}"/>'
    if kind == "chin":
        return f'<path d="M36 62 Q50 82 64 62 Q60 70 50 71.5 Q40 70 36 62 Z" fill="{color}"/>'
    if kind == "sideburns":
        return (
            f'<path d="M31.8 46 L32.5 60 Q35 64 37 58 L36.5 46 Z" fill="{color}"/>'
            f'<path d="M68.2 46 L67.5 60 Q65 64 63 58 L63.5 46 Z" fill="{color}"/>'
        )
    return ""


# Hair: (behind the head, in front of the face).
def hair(style, color):
    shade = "#000"
    if style == "wild":  # spiky cloud of hair
        back = (
            f'<path d="M24 54 Q14 44 22 34 Q16 22 30 20 Q32 8 46 13 Q54 4 63 12 Q78 8 76 22 Q90 26 80 38 Q88 48 76 54 '
            f'Q72 40 66 34 Q50 30 34 34 Q28 40 24 54 Z" fill="{color}"/>'
        )
        front = (
            f'<path d="M32 42 Q34 30 50 30 Q66 30 68 42 Q62 34 56 37 Q52 33 48 37 Q41 33 32 42 Z" fill="{color}"/>'
            f'<path d="M30 30 Q34 34 31 38 M70 30 Q66 34 69 38" stroke="{shade}" stroke-opacity=".12" fill="none"/>'
        )
        return back, front
    if style == "wig":  # long curly baroque wig
        curls = "".join(
            f'<circle cx="{x}" cy="{y}" r="7" fill="{color}"/>'
            for x, y in [(27, 46), (26, 58), (28, 70), (31, 80), (73, 46), (74, 58), (72, 70), (69, 80)]
        )
        back = curls + f'<path d="M28 52 Q24 26 50 22 Q76 26 72 52 Z" fill="{color}"/>'
        front = (
            f'<path d="M31 46 Q33 28 50 28 Q67 28 69 46 Q63 37 50 36 Q37 37 31 46 Z" fill="{color}"/>'
            f'<path d="M36 34 Q40 31 44 34 M56 34 Q60 31 64 34" stroke="{shade}" stroke-opacity=".15" fill="none" stroke-width="1.5"/>'
        )
        return back, front
    if style == "bun":
        back = (
            f'<circle cx="50" cy="24" r="9" fill="{color}"/>'
            f'<path d="M30 54 Q28 28 50 27 Q72 28 70 54 Q68 40 50 37 Q32 40 30 54 Z" fill="{color}"/>'
        )
        front = f'<path d="M31.5 46 Q33 30 50 30 Q67 30 68.5 46 Q60 35 50 38 Q40 35 31.5 46 Z" fill="{color}"/>'
        return back, front
    if style == "side_part":
        back = f'<path d="M30 52 Q27 28 50 26 Q73 28 70 52 Z" fill="{color}"/>'
        front = f'<path d="M31.5 46 Q32 29 50 28 Q68 29 68.5 44 Q66 37 56 36 Q46 35.5 40 39 Q35 41 31.5 46 Z" fill="{color}"/>' \
                f'<path d="M44 31 Q46 34 44 37" stroke="{shade}" stroke-opacity=".18" fill="none" stroke-width="1.2"/>'
        return back, front
    if style == "slick":  # combed straight back
        back = f'<path d="M30.5 50 Q28 26 50 25 Q72 26 69.5 50 Z" fill="{color}"/>'
        front = (
            f'<path d="M31.5 44 Q33 28 50 27.5 Q67 28 68.5 44 Q64 36 50 35 Q36 36 31.5 44 Z" fill="{color}"/>'
            f'<path d="M38 31 Q50 28.5 62 31 M36 35 Q50 31.5 64 35" stroke="#fff" stroke-opacity=".22" fill="none" stroke-width="1"/>'
        )
        return back, front
    if style == "quiff":
        back = f'<path d="M30.5 52 Q28 30 50 28 Q72 30 69.5 52 Z" fill="{color}"/>'
        front = f'<path d="M31.5 45 Q31 33 42 30 Q44 20 58 22 Q70 24 68.5 45 Q64 35 54 35 Q44 34.5 31.5 45 Z" fill="{color}"/>'
        return back, front
    if style == "wavy":
        back = f'<path d="M29 56 Q24 26 50 24 Q76 26 71 56 Q70 44 66 40 L34 40 Q30 44 29 56 Z" fill="{color}"/>'
        front = f'<path d="M31.5 45 Q30 29 40 27 Q50 22 60 27 Q70 29 68.5 45 Q66 38 61 38 Q58 33 54 37 Q50 32 46 37 Q42 33 39 38 Q34 38 31.5 45 Z" fill="{color}"/>'
        return back, front
    if style == "curly_short":
        bumps = "".join(
            f'<circle cx="{x}" cy="{y}" r="5.5" fill="{color}"/>'
            for x, y in [(33, 40), (36, 33), (43, 29), (50, 27.5), (57, 29), (64, 33), (67, 40), (31, 47), (69, 47)]
        )
        return bumps, ""
    if style == "bob":
        back = f'<path d="M28 64 Q24 26 50 25 Q76 26 72 64 Q66 66 64 58 L36 58 Q34 66 28 64 Z" fill="{color}"/>'
        front = f'<path d="M31.5 47 Q31 30 50 29 Q69 30 68.5 47 Q60 38 47 38 Q38 39 31.5 47 Z" fill="{color}"/>'
        return back, front
    if style == "receding":  # high forehead, hair on the sides and a little on top
        back = f'<path d="M30.5 54 Q28 34 36 30 Q50 26 64 30 Q72 34 69.5 54 Z" fill="{color}"/>'
        front = (
            f'<path d="M31.8 50 Q31 40 35 35 L37 44 Q34 46 31.8 50 Z M68.2 50 Q69 40 65 35 L63 44 Q66 46 68.2 50 Z" fill="{color}"/>'
            f'<path d="M45 31.5 Q50 29.5 55 31.5 Q50 33 45 31.5 Z" fill="{color}"/>'
        )
        return back, front
    if style == "bald":  # fringe around the sides only
        back = f'<path d="M30.5 56 Q29 46 33 42 L35 56 Z M69.5 56 Q71 46 67 42 L65 56 Z" fill="{color}"/>'
        front = f'<path d="M31.8 52 Q31 44 34 40 L36.5 48 Q33.5 49 31.8 52 Z M68.2 52 Q69 44 66 40 L63.5 48 Q66.5 49 68.2 52 Z" fill="{color}"/>'
        return back, front
    if style == "long_straight":
        back = f'<path d="M27 80 Q22 28 50 25 Q78 28 73 80 Q68 82 66 70 L34 70 Q32 82 27 80 Z" fill="{color}"/>'
        front = f'<path d="M31.5 48 Q30 30 50 29 Q70 30 68.5 48 Q64 36 52 35 Q40 36 31.5 48 Z" fill="{color}"/>'
        return back, front
    return "", ""


# Hats and head gear (drawn over the hair).
def beret(color):
    return (
        f'<path d="M27 37 Q30 22 52 22 Q74 22 74 33 Q70 38 50 38 Q34 38 27 37 Z" fill="{color}"/>'
        f'<path d="M50 22 L50 18" stroke="{color}" stroke-width="3" stroke-linecap="round"/>'
    )


def turban(color):
    return (
        f'<path d="M30 44 Q27 22 50 19 Q73 22 70 44 Q60 36 50 37 Q40 36 30 44 Z" fill="{color}"/>'
        f'<path d="M33 36 Q50 24 67 36 M32 41 Q50 28 68 41" stroke="#000" stroke-opacity=".15" fill="none" stroke-width="1.6"/>'
        '<circle cx="50" cy="31" r="2.6" fill="#f2c94c"/>'
    )


def cap_backwards(color):
    return (
        f'<path d="M30 42 Q30 24 50 24 Q70 24 70 42 Q60 36 50 36 Q40 36 30 42 Z" fill="{color}"/>'
        f'<path d="M62 30 Q74 28 80 34 Q74 37 67 37 Z" fill="{color}" stroke="#000" stroke-opacity=".2"/>'
        '<circle cx="50" cy="25" r="1.6" fill="#fff" fill-opacity=".6"/>'
    )


def laurel(color="#4f8a3a"):
    leaves = "".join(
        f'<ellipse cx="{x}" cy="{y}" rx="4.2" ry="2" transform="rotate({r} {x} {y})" fill="{color}"/>'
        for x, y, r in [(32, 40, -60), (34, 34, -40), (39, 29.5, -20), (45, 27.5, -5),
                        (68, 40, 60), (66, 34, 40), (61, 29.5, 20), (55, 27.5, 5)]
    )
    return leaves


def headphones(color="#e4572e"):
    return (
        f'<path d="M29 52 Q27 22 50 22 Q73 22 71 52" fill="none" stroke="{INK}" stroke-width="3"/>'
        f'<rect x="24" y="47" width="9" height="14" rx="4" fill="{color}"/>'
        f'<rect x="67" y="47" width="9" height="14" rx="4" fill="{color}"/>'
    )


# Clothes (collars on top of the body).
def shirt_tie(tie="#c0392b", shirt="#fff"):
    return (
        f'<path d="M41 78 L50 92 L59 78 Q50 81 41 78 Z" fill="{shirt}"/>'
        f'<path d="M48 82 L52 82 L53.5 95 L50 99 L46.5 95 Z" fill="{tie}"/>'
    )


def bow_tie(color="#1f2328", shirt="#fff"):
    return (
        f'<path d="M41 78 L50 90 L59 78 Q50 81 41 78 Z" fill="{shirt}"/>'
        f'<path d="M50 82 L42 78.5 L42 86 Z M50 82 L58 78.5 L58 86 Z" fill="{color}"/><circle cx="50" cy="82" r="2" fill="{color}"/>'
    )


def turtleneck(color):
    return f'<path d="M41 71 Q50 75 59 71 L60 81 Q50 85 40 81 Z" fill="{color}" stroke="#000" stroke-opacity=".12"/>'


def lab_coat():
    return (
        '<path d="M12 104 C14 84 30 77 50 77 C70 77 86 84 88 104 Z" fill="#fafafa"/>'
        '<path d="M41 77 L50 95 L59 77 Z" fill="#cfe3f7"/>'
        '<path d="M41 77 L36 90 L44 88 L50 95 M59 77 L64 90 L56 88 L50 95" fill="none" stroke="#c9cfd6" stroke-width="1.4"/>'
    )


def ruff():
    puffs = "".join(f'<circle cx="{x}" cy="{y}" r="4.4" fill="#fbfbf7" stroke="#d9d6cc" stroke-width=".8"/>'
                    for x, y in [(36, 78), (42, 81), (50, 82), (58, 81), (64, 78), (40, 75), (60, 75)])
    return puffs


def hoodie(color):
    return (
        f'<path d="M30 80 Q26 64 34 58 L38 78 Z M70 80 Q74 64 66 58 L62 78 Z" fill="{color}" stroke="#000" stroke-opacity=".1"/>'
        '<path d="M45 80 L44 92 M55 80 L56 92" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'
    )


def toga():
    return (
        '<path d="M12 104 C14 84 30 77 50 77 C70 77 86 84 88 104 Z" fill="#f3efe4"/>'
        '<path d="M30 81 Q50 98 78 84" fill="none" stroke="#c9a227" stroke-width="3"/>'
        '<path d="M62 79 L74 100" stroke="#d8d1bf" stroke-width="1.5"/>'
    )


def mandarin(color, trim="#f2c94c"):
    return (
        f'<path d="M42 73 L42 80 Q50 83 58 80 L58 73 Q50 76 42 73 Z" fill="{color}" stroke="{trim}" stroke-width="1"/>'
        f'<path d="M50 82 Q56 86 54 94" fill="none" stroke="{trim}" stroke-width="1.4"/>'
    )


def chain(text="h", color="#f2c94c"):
    return (
        f'<path d="M37 80 Q50 92 63 80" fill="none" stroke="{color}" stroke-width="1.6" stroke-dasharray="2 1.2"/>'
        f'<circle cx="50" cy="90" r="5.2" fill="{color}" stroke="#a37f12"/>'
        f'<text x="50" y="92.6" font-family="Georgia,serif" font-weight="700" font-size="7" text-anchor="middle" fill="#5a4307">{text}</text>'
    )


# Props and backdrops.
def text(x, y, s, size=9, color="#fff", anchor="middle", weight=700, rotate=0, opacity=1):
    rot = f' transform="rotate({rotate} {x} {y})"' if rotate else ""
    return (f'<text x="{x}" y="{y}" font-family="Georgia,\'Times New Roman\',serif" font-style="italic" '
            f'font-weight="{weight}" font-size="{size}" text-anchor="{anchor}" fill="{color}" fill-opacity="{opacity}"{rot}>{s}</text>')


def apple(x=50, y=20):
    return (
        f'<circle cx="{x - 3}" cy="{y}" r="6" fill="#d7263d"/><circle cx="{x + 3}" cy="{y}" r="6" fill="#d7263d"/>'
        f'<path d="M{x} {y - 5} L{x + 1} {y - 10}" stroke="#5b3a29" stroke-width="1.6" stroke-linecap="round"/>'
        f'<ellipse cx="{x + 4.5}" cy="{y - 9}" rx="3.5" ry="1.6" transform="rotate(-25 {x + 4.5} {y - 9})" fill="#4caf50"/>'
        f'<ellipse cx="{x - 4}" cy="{y - 2.5}" rx="1.6" ry="1" fill="#fff" fill-opacity=".6"/>'
    )


def atom(cx, cy, s=1.0, color="#fff", opacity=0.5):
    rings = "".join(
        f'<ellipse cx="{cx}" cy="{cy}" rx="{16 * s}" ry="{6 * s}" transform="rotate({r} {cx} {cy})" fill="none" stroke="{color}" stroke-opacity="{opacity}" stroke-width="{1.4 * s}"/>'
        for r in (0, 60, 120)
    )
    return rings + f'<circle cx="{cx}" cy="{cy}" r="{2.8 * s}" fill="{color}" fill-opacity="{opacity + .2}"/>'


def bolt(x, y, s=1.0, color="#ffe14d"):
    return (f'<path transform="translate({x} {y}) scale({s})" d="M4 0 L-6 14 L0 14 L-4 26 L8 9 L2 9 L6 0 Z" fill="{color}" '
            'stroke="#e0a800" stroke-width=".8"/>')


def flask(x, y):
    return (
        f'<g transform="translate({x} {y})">'
        '<circle cx="0" cy="6" r="11" fill="#9cff8a" fill-opacity=".35"/>'
        '<path d="M-3 -6 L3 -6 L3 1 L8 10 Q9 13 6 13 L-6 13 Q-9 13 -8 10 L-3 1 Z" fill="#e9fbff" stroke="#5c7a8a" stroke-width="1"/>'
        '<path d="M-6.5 8 L6.5 8 L8 10.5 Q8.6 12.5 6 12.5 L-6 12.5 Q-8.6 12.5 -8 10.5 Z" fill="#5cff5c"/>'
        '<circle cx="-1" cy="5" r="1.2" fill="#5cff5c"/><circle cx="2" cy="2" r=".9" fill="#5cff5c"/>'
        '</g>'
    )


def telescope(x, y):
    return (
        f'<g transform="translate({x} {y}) rotate(-35)">'
        '<rect x="-14" y="-3.5" width="22" height="7" rx="1.5" fill="#a0612b" stroke="#6b3e17"/>'
        '<rect x="8" y="-4.5" width="7" height="9" rx="1.5" fill="#d4a24c" stroke="#6b3e17"/>'
        '<rect x="-19" y="-2.5" width="6" height="5" rx="1" fill="#d4a24c" stroke="#6b3e17"/>'
        '</g>'
    )


def cat_box(x, y):
    return (
        f'<g transform="translate({x} {y})">'
        '<path d="M-9 -9 L-6 -16 L-3 -10 Z M3 -10 L6 -16 L9 -9 Z" fill="#f39c3d"/>'
        '<ellipse cx="0" cy="-5" rx="9.5" ry="7.5" fill="#f39c3d"/>'
        '<circle cx="-3.5" cy="-6" r="1.4" fill="#1f2328"/><circle cx="3.5" cy="-6" r="1.4" fill="#1f2328"/>'
        '<path d="M-1 -3 L1 -3 L0 -2 Z" fill="#c0392b"/>'
        '<path d="M-5 -3 L-11 -4 M-5 -2 L-11 -1 M5 -3 L11 -4 M5 -2 L11 -1" stroke="#1f2328" stroke-width=".5"/>'
        '<rect x="-12" y="-1" width="24" height="13" fill="#c8955a" stroke="#8b6239"/>'
        '<path d="M-12 -1 L-16 -6 L8 -6 L12 -1" fill="#d9a86c" stroke="#8b6239"/>'
        '<text x="0" y="8.5" font-family="Arial" font-weight="700" font-size="6" text-anchor="middle" fill="#6b4422">?</text>'
        '</g>'
    )


def magnet(x, y):
    return (
        f'<g transform="translate({x} {y}) rotate(20)">'
        '<path d="M-9 -8 L-9 2 Q-9 11 0 11 Q9 11 9 2 L9 -8 L4 -8 L4 2 Q4 6 0 6 Q-4 6 -4 2 L-4 -8 Z" fill="#d7263d"/>'
        '<rect x="-9" y="-12" width="5" height="4" fill="#ddd"/><rect x="4" y="-12" width="5" height="4" fill="#ddd"/>'
        '</g>'
    )


def rainbow(cy=72):
    colors = ["#ff4d4d", "#ff9f1c", "#ffe14d", "#4cd964", "#4da3ff", "#7b61ff"]
    return "".join(
        f'<path d="M{8 + i * 3} {cy} A{42 - i * 3} {42 - i * 3} 0 0 1 {92 - i * 3} {cy}" fill="none" stroke="{c}" stroke-width="3" stroke-opacity=".55"/>'
        for i, c in enumerate(colors)
    )


def orbit_sun():
    return (
        '<ellipse cx="50" cy="50" rx="44" ry="26" transform="rotate(-20 50 50)" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.3" stroke-dasharray="3 2"/>'
        '<circle cx="15" cy="30" r="6" fill="#ffd23f"/><circle cx="86" cy="62" r="3" fill="#7fd1ff"/>'
    )


def galaxy(cx=50, cy=50, color="#fff"):
    arms = "".join(
        f'<path d="M{cx} {cy} q14 -4 18 8 q2 10 -10 14" transform="rotate({r} {cx} {cy})" fill="none" stroke="{color}" stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round"/>'
        for r in (0, 120, 240)
    )
    stars = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" fill-opacity=".8"/>'
                    for x, y, r in [(14, 22, 1), (82, 16, 1.3), (88, 44, .8), (12, 62, .9), (24, 12, .7), (74, 30, .7)])
    return stars + arms


def black_hole():
    return (
        '<circle cx="50" cy="50" r="50" fill="#0b0b1a"/>'
        '<ellipse cx="50" cy="22" rx="40" ry="8" fill="none" stroke="#ff9f1c" stroke-opacity=".8" stroke-width="3"/>'
        '<circle cx="50" cy="22" r="10" fill="#000" stroke="#ffd166" stroke-width="1.5"/>'
        + "".join(f'<circle cx="{x}" cy="{y}" r=".9" fill="#fff"/>' for x, y in [(12, 40), (86, 40), (20, 64), (82, 70), (30, 10), (72, 8)])
    )


def pendulum(x, y):
    return (
        f'<path d="M{x} {y} L{x + 7} {y + 24}" stroke="#c9a227" stroke-width="1.4"/>'
        f'<circle cx="{x + 7}" cy="{y + 26}" r="4" fill="#ffd23f" stroke="#a37f12"/>'
        f'<path d="M{x - 9} {y + 20} Q{x + 7} {y + 32} {x + 22} {y + 20}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-dasharray="2 2"/>'
    )


def snowflake(x, y, s=1.0, color="#fff"):
    arms = "".join(
        f'<path d="M0 0 L0 -10 M0 -6 L-3 -9 M0 -6 L3 -9" transform="rotate({r})" stroke="{color}" stroke-width="1.4" stroke-linecap="round"/>'
        for r in range(0, 360, 60)
    )
    return f'<g transform="translate({x} {y}) scale({s})">{arms}</g>'


def bongo(x, y):
    return (
        f'<g transform="translate({x} {y})">'
        '<path d="M-8 -4 L-6 10 L6 10 L8 -4 Z" fill="#b5651d" stroke="#6b3e17"/>'
        '<ellipse cx="0" cy="-4" rx="8" ry="3" fill="#f5deb3" stroke="#6b3e17"/>'
        '<path d="M-7 3 L7 3" stroke="#e8c27a" stroke-width="1.4"/>'
        '</g>'
    )


def wave(y, color="#fff", opacity=.5, amp=4):
    return (f'<path d="M6 {y} q6 -{amp} 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0" fill="none" stroke="{color}" '
            f'stroke-opacity="{opacity}" stroke-width="2" stroke-linecap="round"/>')


def no_sign(x, y):
    return (f'<circle cx="{x}" cy="{y}" r="8" fill="#fff" stroke="#e63946" stroke-width="2.6"/>'
            f'<path d="M{x - 5.5} {y + 5.5} L{x + 5.5} {y - 5.5}" stroke="#e63946" stroke-width="2.6"/>')


def split_atom(x, y):
    return (
        f'<circle cx="{x - 4}" cy="{y}" r="5" fill="#ff6b6b"/><circle cx="{x + 6}" cy="{y + 2}" r="4" fill="#4dabf7"/>'
        f'<path d="M{x + 1} {y - 7} L{x - 1} {y + 8}" stroke="#ffe14d" stroke-width="2" stroke-dasharray="2 1.5"/>'
        f'<path d="M{x + 11} {y - 6} l5 -3 M{x + 12} {y + 6} l5 3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>'
    )


def mirror(x, y):
    return (f'<rect x="{x - 1}" y="{y - 11}" width="2" height="22" fill="#fff" fill-opacity=".8"/>'
            f'<path d="M{x - 9} {y} q-4 -6 0 -9 M{x + 9} {y} q4 -6 0 -9" fill="none" stroke="#fff" stroke-width="1.6"/>'
            f'<path d="M{x - 9} {y} l-2 -3 M{x + 9} {y} l2 -3" stroke="#fff" stroke-width="1.6"/>')


def prism(x, y):
    return (
        f'<path d="M{x} {y - 9} L{x + 9} {y + 7} L{x - 9} {y + 7} Z" fill="#e8f6ff" fill-opacity=".85" stroke="#9ec9e2"/>'
        f'<path d="M{x - 26} {y + 2} L{x - 4} {y}" stroke="#fff" stroke-width="2"/>'
        + "".join(f'<path d="M{x + 5} {y + 1} L{x + 20} {y - 6 + i * 3}" stroke="{c}" stroke-width="1.6"/>'
                  for i, c in enumerate(["#ff4d4d", "#ffe14d", "#4cd964", "#4da3ff", "#7b61ff"]))
    )


def speech(x, y, s, w=30):
    return (
        f'<path d="M{x} {y} h{w} q4 0 4 4 v8 q0 4 -4 4 h-{w - 8} l-6 5 v-5 h-0 q-4 0 -4 -4 v-8 q0 -4 4 -4 z" '
        'fill="#fff" stroke="#1f2328" stroke-width="1"/>'
        + f'<text x="{x + w / 2 + 2}" y="{y + 10.5}" font-family="Arial,sans-serif" font-weight="800" font-size="7" text-anchor="middle" fill="#1f2328">{s}</text>'
    )


def gear(x, y, color="#fff"):
    teeth = "".join(f'<rect x="-1.6" y="-9" width="3.2" height="4" transform="rotate({r})" fill="{color}"/>' for r in range(0, 360, 45))
    return f'<g transform="translate({x} {y})" opacity=".55">{teeth}<circle r="6" fill="none" stroke="{color}" stroke-width="2.4"/></g>'


# -- the physicists ----------------------------------------------------------


def avatar(bg, skin, hair_style, hair_color, *, eyes_kind="dots", mouth_kind="smile", brow=None,
           backdrop="", clothes=None, collar="", facial="", glasses="", head="", front="", brow_tilt=0):
    s = SKIN[skin]
    hc = HAIR[hair_color] if hair_color in HAIR else hair_color
    back, fringe = hair(hair_style, hc)
    clothes_svg = body(clothes or "#34495e", collar) if not callable(clothes) else clothes()
    if collar and callable(clothes):
        clothes_svg += collar
    parts = [
        background(bg, backdrop),
        clothes_svg,
        neck(s),
        back,
        face(s),
        eyes(eyes_kind, brow or (hc if hair_color not in ("white", "grey") else "#8a8a8a"), brow_tilt),
        mouth(mouth_kind),
        facial,
        fringe,
        glasses,
        head,
        front,
    ]
    return parts


PHYSICISTS = [
    ("newton", "Isaac Newton", lambda: avatar(
        "#5b8def", "light", "wig", "white", mouth_kind="smirk",
        clothes="#7b2d26", collar=shirt_tie("#fff", "#f3e9d2"), head=apple(50, 18))),
    ("einstein", "Albert Einstein", lambda: avatar(
        "#f4a259", "fair", "wild", "white", mouth_kind="tongue",
        clothes="#6d6875", collar=turtleneck("#b5838d"),
        facial=mustache("walrus", "#e8e8e8"), glasses=sunglasses(),
        front=text(50, 95, "E=mc²", 8.5, "#fff"))),
    ("curie", "Marie Curie", lambda: avatar(
        "#2a9d8f", "light", "bun", "brown", mouth_kind="smile",
        backdrop=atom(22, 28, .8, "#c9ffb3", .6),
        clothes=lab_coat, glasses=square_glasses("#1f2328"), front=flask(78, 78))),
    ("feynman", "Richard Feynman", lambda: avatar(
        "#ef476f", "fair", "wavy", "brown", mouth_kind="grin", eyes_kind="wink",
        backdrop=wave(24, "#fff", .7) + '<path d="M60 36 L74 26 M74 26 L70 26 M74 26 L73 30" stroke="#fff" stroke-opacity=".7" stroke-width="2"/>',
        clothes="#ffd166", collar=hoodie("#ffb703"), head=headphones("#118ab2"), front=bongo(26, 82))),
    ("noether", "Emmy Noether", lambda: avatar(
        "#8338ec", "light", "bob", "dark", mouth_kind="smile",
        backdrop=text(24, 34, "δS=0", 9, opacity=.85) + text(77, 34, "∂L", 11, opacity=.85),
        clothes="#3a0ca3", collar=mandarin("#4361ee", "#f72585"), glasses=round_glasses("#1f2328", 5.4))),
    ("bohr", "Niels Bohr", lambda: avatar(
        "#06d6a0", "fair", "receding", "brown", mouth_kind="smile",
        backdrop=atom(50, 24, 1.9, "#fff", .45),
        clothes="#073b4c", collar=bow_tie("#ef476f"))),
    ("heisenberg", "Werner Heisenberg", lambda: avatar(
        "#264653", "fair", "quiff", "blond", mouth_kind="smirk",
        backdrop=text(50, 16, "Δx·Δp ≥ ħ/2", 9, opacity=.75),
        clothes="#1d3557", collar=turtleneck("#111"), glasses=sunglasses("#2b2d42", "#d4af37"))),
    ("schrodinger", "Erwin Schrödinger", lambda: avatar(
        "#90be6d", "fair", "side_part", "dark", mouth_kind="o",
        backdrop=text(25, 34, "ψ", 15, opacity=.85),
        clothes="#3d405b", collar=bow_tie("#f2cc8f"), glasses=round_glasses("#1f2328"), front=cat_box(77, 84))),
    ("dirac", "Paul Dirac", lambda: avatar(
        "#118ab2", "light", "slick", "dark", mouth_kind="smirk",
        backdrop=text(50, 17, "⟨ψ|φ⟩", 12, opacity=.85),
        clothes="#22223b", collar=shirt_tie("#4a4e69"))),
    ("maxwell", "James Clerk Maxwell", lambda: avatar(
        "#073b4c", "light", "wavy", "dark", mouth_kind="smile",
        backdrop=rainbow(60) + text(74, 28, "∇·E", 9, opacity=.85),
        clothes="#5c4033", collar=bow_tie("#1f2328"), facial=beard("big", "#3d2b22"))),
    ("faraday", "Michael Faraday", lambda: avatar(
        "#e76f51", "light", "side_part", "grey", mouth_kind="smile",
        backdrop=bolt(14, 14, .8) + bolt(76, 12, .7),
        clothes="#264653", collar=bow_tie("#fff", "#e9e9e9"), facial=beard("sideburns", "#9aa0a6"), front=magnet(80, 82))),
    ("tesla", "Nikola Tesla", lambda: avatar(
        "#3a0ca3", "fair", "slick", "black", mouth_kind="smirk",
        backdrop=bolt(12, 10, 1.1) + bolt(78, 8, .9) + bolt(84, 54, .6),
        clothes="#14213d", collar=shirt_tie("#fca311"), facial=mustache("thin", "#26201e"), glasses=sunglasses())),
    ("galileo", "Galileo Galilei", lambda: avatar(
        "#1d3557", "medium", "receding", "auburn", mouth_kind="smile",
        backdrop='<circle cx="80" cy="22" r="9" fill="#f1faee"/><circle cx="83" cy="20" r="2" fill="#a8dadc"/>'
                 + "".join(f'<circle cx="{x}" cy="{y}" r="1" fill="#fff"/>' for x, y in [(16, 20), (24, 34), (66, 10)]),
        clothes="#6a040f", collar=ruff(), facial=beard("full", "#8a4b2a"),
        head=beret("#2b2d42"), front=telescope(25, 80))),
    ("kepler", "Johannes Kepler", lambda: avatar(
        "#14213d", "light", "side_part", "dark", mouth_kind="smile",
        backdrop=orbit_sun(), clothes="#1b4332", collar=ruff(), facial=beard("goatee", "#3d2b22")
        + mustache("curl", "#3d2b22"))),
    ("planck", "Max Planck", lambda: avatar(
        "#ffb703", "fair", "bald", "grey", mouth_kind="smile",
        backdrop=text(26, 32, "E=hν", 9, "#7a4b00", opacity=.8),
        clothes="#1f2328", collar=shirt_tie("#6a4c93") + chain("h"), facial=mustache("default", "#9aa0a6"),
        glasses=round_glasses("#3b3b3b", 4.8))),
    ("pauli", "Wolfgang Pauli", lambda: avatar(
        "#ff006e", "fair", "receding", "dark", mouth_kind="grin",
        backdrop=no_sign(76, 26) + text(25, 32, "↑↓", 12, opacity=.9),
        clothes="#1f2328", collar=hoodie("#3a3a3a"), glasses=square_glasses("#111"),
        head=cap_backwards("#111"))),
    ("fermi", "Enrico Fermi", lambda: avatar(
        "#fb8500", "medium", "receding", "dark", mouth_kind="grin",
        backdrop=atom(24, 30, .8, "#fff", .6) + text(77, 34, "ν", 14, opacity=.9),
        clothes="#023047", collar=shirt_tie("#219ebc"), glasses=sunglasses("#111", "#111"))),
    ("meitner", "Lise Meitner", lambda: avatar(
        "#4361ee", "light", "bun", "grey", mouth_kind="smile",
        backdrop=split_atom(26, 30),
        clothes="#2b2d42", collar=mandarin("#ffffff", "#adb5bd"))),
    ("rutherford", "Ernest Rutherford", lambda: avatar(
        "#2b9348", "fair", "receding", "grey", mouth_kind="smile",
        backdrop='<circle cx="80" cy="26" r="3" fill="#ffd23f"/>'
                 + "".join(f'<path d="M58 {18 + i * 6} L76 {22 + i * 2}" stroke="#fff" stroke-opacity=".6" stroke-width="1.3"/>' for i in range(3))
                 + '<path d="M78 28 L70 38" stroke="#fff" stroke-opacity=".8" stroke-width="1.3"/>',
        clothes="#3c3c3c", collar=shirt_tie("#9b2226"), facial=mustache("walrus", "#cfd2d6"))),
    ("hawking", "Stephen Hawking", lambda: avatar(
        "#0b0b1a", "light", "side_part", "brown", mouth_kind="smile",
        backdrop=black_hole(), clothes="#4a4e69", collar=shirt_tie("#22223b", "#e0e0e0"),
        glasses=square_glasses("#3a3a3a"))),
    ("boltzmann", "Ludwig Boltzmann", lambda: avatar(
        "#9d4edd", "fair", "receding", "brown", mouth_kind="smile",
        backdrop=text(50, 17, "S = k log W", 9, opacity=.85),
        clothes="#3c096c", collar=bow_tie("#1f2328"), facial=beard("big", "#6b4430"),
        glasses=round_glasses("#1f2328", 5))),
    ("wu", "Chien-Shiung Wu", lambda: avatar(
        "#00b4d8", "fair", "bob", "black", mouth_kind="smile",
        backdrop=text(24, 34, "⁶⁰Co", 9, opacity=.9) + text(77, 32, "β⁻", 11, opacity=.9),
        clothes="#0077b6", collar=mandarin("#90e0ef", "#f2c94c"), glasses=round_glasses("#1f2328", 5))),
    ("hubble", "Edwin Hubble", lambda: avatar(
        "#10002b", "light", "slick", "brown", mouth_kind="smirk",
        backdrop=galaxy(74, 28, "#c77dff"),
        clothes="#5a189a", collar=shirt_tie("#e0aaff"), glasses=sunglasses("#240046", "#c77dff"))),
    ("rubin", "Vera Rubin", lambda: avatar(
        "#3c096c", "light", "curly_short", "dark", mouth_kind="grin",
        backdrop=galaxy(26, 30, "#ffd6ff"),
        clothes="#7b2cbf", collar=turtleneck("#e0aaff"), glasses=round_glasses("#e0aaff", 5.2))),
    ("bose", "Satyendra Nath Bose", lambda: avatar(
        "#f77f00", "tan", "wavy", "grey", mouth_kind="smile",
        backdrop=wave(22, "#fff", .7, 5) + text(78, 40, "γ", 13, opacity=.9),
        clothes="#003049", collar=mandarin("#fcbf49", "#d62828"), facial=mustache("default", "#d0d0d0"),
        glasses=round_glasses("#1f2328", 5))),
    ("raman", "C. V. Raman", lambda: avatar(
        "#118ab2", "brown", "", "black", mouth_kind="smile",
        backdrop=prism(70, 26), clothes="#073b4c", collar=mandarin("#fefae0", "#dda15e"),
        head=turban("#fefae0"))),
    ("yukawa", "Hideki Yukawa", lambda: avatar(
        "#e63946", "fair", "side_part", "black", mouth_kind="smile",
        backdrop=wave(22, "#fff", .8, 3) + text(78, 42, "π", 13, opacity=.9),
        clothes="#1d3557", collar=shirt_tie("#a8dadc"), glasses=round_glasses("#1f2328", 5))),
    ("archimedes", "Archimedes", lambda: avatar(
        "#e9c46a", "tan", "curly_short", "grey", mouth_kind="grin",
        backdrop=speech(44, 9, "Eureka!", 30) + '<path d="M8 86 L44 70" stroke="#6b3e17" stroke-width="2.5"/><path d="M22 84 L26 78 L30 84 Z" fill="#6b3e17"/>',
        clothes=toga, facial=beard("full", "#d0d0d0"), head=laurel())),
    ("huygens", "Christiaan Huygens", lambda: avatar(
        "#457b9d", "light", "wig", "brown", mouth_kind="smile",
        backdrop=pendulum(72, 10), clothes="#1d3557", collar=shirt_tie("#fff", "#f1faee"),
        facial=mustache("thin", "#5b3a29"))),
    ("kelvin", "Lord Kelvin", lambda: avatar(
        "#48cae4", "light", "receding", "grey", mouth_kind="smirk",
        backdrop=snowflake(24, 28, 1) + snowflake(78, 38, .7) + text(70, 22, "0 K", 9, "#03045e", opacity=.85),
        clothes="#03045e", collar=bow_tie("#1f2328"), facial=beard("chin", "#cfd2d6"))),
]


def render(parts, title):
    inner = "".join(p for p in parts if p)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img">'
        f'<title>{title}</title><defs><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs>'
        f'<g clip-path="url(#c)">{inner}</g></svg>\n'
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, name, build in PHYSICISTS:
        (OUT / f"{slug}.svg").write_text(render(build(), name), encoding="utf-8")
    rows = "".join(f'    ("{slug}", "{name}"),\n' for slug, name, _ in PHYSICISTS)
    LIST.write_text(
        "# SPDX-License-Identifier: Apache-2.0\n"
        '"""The built-in game avatars (generated by fork/avatars/generate.py; the\n'
        'SVGs are in quizbar/static/quizbar/avatars/, see quizbar/avatars.py)."""\n\n'
        f"AVATARS = (\n{rows})\n",
        encoding="utf-8",
    )
    print(f"{len(PHYSICISTS)} avatars written to {OUT}")


if __name__ == "__main__":
    main()
