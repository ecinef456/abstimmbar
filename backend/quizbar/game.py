# SPDX-License-Identifier: Apache-2.0
"""Game mode for live polls (Kahoot style).

Players get a name per run (their own nickname, or a random funny one when
the set does not ask for nicknames) and, if the set allows, an avatar. A
correct answer to a single/multiple
choice question earns 500–1000 points, more the faster it came (all
choices of a multiple-choice question must be right). Questions without a
correct answer score nothing. Points are computed from the votes, so
nothing is stored per answer: only when each question was first opened.
"""
import random
import re

from django.db import IntegrityError, transaction
from django.db.models import Q

from live.models import Run, Vote
from rooms.models import Question

from . import avatars as avatar_files
from . import funny_names
from .models import GameEntry, GameQuestion, SetGame

NICKNAME_MAX = 20
DEFAULT_SECONDS = 20  # the speed window of a question without a time limit
SCORED_KINDS = (Question.Kind.SINGLE_CHOICE, Question.Kind.MULTIPLE_CHOICE)


OPTIONS = ("enabled", "nicknames", "avatars")


def enabled(question_set):
    return SetGame.objects.filter(question_set=question_set, enabled=True).exists()


def options(question_set):
    """{enabled, nicknames, avatars} — everything off unless switched on."""
    game = SetGame.objects.filter(question_set=question_set).first()
    if game is None:
        return dict.fromkeys(OPTIONS, False)
    return {"enabled": game.enabled, "nicknames": game.nicknames, "avatars": game.avatars}


def set_options(question_set, **changes):
    values = {k: bool(v) for k, v in changes.items() if k in OPTIONS and v is not None}
    SetGame.objects.update_or_create(question_set=question_set, defaults=values)
    return options(question_set)


def set_enabled(question_set, on):
    set_options(question_set, enabled=on)


def copy_setting(source, clone):
    """A duplicated set keeps its game mode and options."""
    current = options(source)
    if any(current.values()):
        set_options(clone, **current)


def avatar_fields(slug):
    """The avatar's slug and pictures for payloads ({} for none)."""
    found = avatar_files.get(slug)
    if not found:
        return {"avatar": "", "avatar_icon": None, "avatar_full": None}
    return {"avatar": slug, "avatar_icon": found["icon"], "avatar_full": found["full"]}


def clean_nickname(raw):
    name = " ".join(str(raw or "").split())
    name = re.sub(r"[\x00-\x1f\x7f<>]", "", name)
    return name[:NICKNAME_MAX].strip()


# -- hooks -------------------------------------------------------------------


def on_run_saved(run):
    """Run post_save: remember when each question of a game run first opened."""
    if (
        run.mode != Run.Mode.LIVE
        or run.phase != Run.Phase.OPEN
        or not run.active_question_id
        or not run.opened_at
        or not enabled(run.question_set_id)
    ):
        return
    GameQuestion.objects.get_or_create(
        run=run, question_id=run.active_question_id, defaults={"opened_at": run.opened_at}
    )


def attach(run, participant, presenter):
    """build_payloads hook: the game flag for phones (``revealed``: the
    active question's points may be shown), the players for the beamer."""
    if run.mode != Run.Mode.LIVE or not enabled(run.question_set):
        return
    revealed = run.active_question_id is not None and hidden_question(run) is None
    participant["game"] = {
        "run": run.pk,
        "question": run.active_question_id,
        "revealed": revealed,
    }
    players = [
        {"nickname": nickname, **avatar_fields(avatar)}
        for nickname, avatar in GameEntry.objects.filter(run=run).values_list("nickname", "avatar")
    ]
    presenter["game"] = {"players": players, "avatars": options(run.question_set)["avatars"]}


# -- scoring -----------------------------------------------------------------


def points_for(seconds, limit):
    window = limit or DEFAULT_SECONDS
    share = min(max(seconds, 0.0) / window, 1.0)
    return round(1000 * (1 - share / 2))


def _scored_questions(run, hide_question=None):
    opened = {
        gq.question_id: gq.opened_at
        for gq in GameQuestion.objects.filter(run=run).exclude(question_id=hide_question)
    }
    questions = Question.objects.filter(pk__in=opened, kind__in=SCORED_KINDS).prefetch_related(
        "options"
    )
    out = {}
    for question in questions:
        correct = {o.pk for o in question.options.all() if o.is_correct}
        if correct:
            out[question.pk] = (correct, opened[question.pk], question.time_limit)
    return out


def standings(run, hide_question=None):
    """Players with total and per-question points, best first, ranked
    (equal points share a rank). ``hide_question`` leaves out a question
    whose answers are not revealed yet."""
    scored = _scored_questions(run, hide_question)
    entries = {e.token_id: e for e in GameEntry.objects.filter(run=run)}
    per = {token: {} for token in entries}
    votes = (
        Vote.objects.filter(run=run, question_id__in=scored, token_id__in=entries)
        .prefetch_related("options")
        .order_by("created_at")
    )
    for vote in votes:
        correct, opened_at, limit = scored[vote.question_id]
        if vote.question_id in per[vote.token_id]:
            continue
        chosen = {o.pk for o in vote.options.all()}
        if chosen == correct:
            seconds = (vote.created_at - opened_at).total_seconds()
            per[vote.token_id][vote.question_id] = points_for(seconds, limit)
        else:
            per[vote.token_id][vote.question_id] = 0
    last_question = max(scored, key=lambda q: scored[q][1], default=None)
    rows = []
    for token, entry in entries.items():
        rows.append(
            {
                "token": token,
                "nickname": entry.nickname,
                "avatar": entry.avatar,
                "score": sum(per[token].values()),
                "last": per[token].get(last_question),
                "answered_last": last_question in per[token],
            }
        )
    rows.sort(key=lambda r: (-r["score"], r["nickname"].lower()))
    rank, previous = 0, None
    for index, row in enumerate(rows, start=1):
        if row["score"] != previous:
            rank, previous = index, row["score"]
        row["rank"] = rank
    return {"rows": rows, "questions": len(scored), "last_question": last_question}


def hidden_question(run):
    """The active question while its solution is not shown yet (its points
    would give it away): until E, or until the results if the set reveals
    "immediately with the results"."""
    question = run.active_question
    if run.phase == Run.Phase.FINISHED or question is None or run.answers_revealed:
        return None
    if run.phase == Run.Phase.RESULTS and question.effective_reveal == "immediately":
        return None
    return question.pk


def leaderboard(run, limit=10, final=False):
    """Top players. ``final`` (the podium, the game is over) counts every
    question, even the last one whose solution was not shown."""
    data = standings(run, hide_question=None if final else hidden_question(run))
    return {
        "players": len(data["rows"]),
        "questions": data["questions"],
        "leaderboard": [
            {
                **{k: row[k] for k in ("rank", "nickname", "score", "last")},
                **avatar_fields(row["avatar"]),
            }
            for row in data["rows"][:limit]
        ],
    }


def me(run, token):
    """A player's own view: name, avatar, score, rank, last question's points.
    Before joining: what the join screen must ask for (``needs``)."""
    settings = options(run.question_set)
    entry = GameEntry.objects.filter(run=run, token=token).first()
    out = {
        "game": True,
        "run": run.pk,
        "finished": run.phase == Run.Phase.FINISHED,
        "nickname": entry.nickname if entry else None,
        **avatar_fields(entry.avatar if entry else ""),
    }
    if entry is None:
        previous = (
            GameEntry.objects.filter(token=token)
            .order_by("-joined_at")
            .values_list("nickname", "avatar")
            .first()
        )
        out["needs"] = {"nickname": settings["nicknames"], "avatar": settings["avatars"]}
        out["name"] = random_name(run, token)
        if settings["nicknames"]:
            out["suggested"] = previous[0] if previous else ""
        if settings["avatars"]:
            out["suggested_avatar"] = (previous[1] if previous else "") or free_avatar(run)
            out["avatars"] = avatar_files.available()
        return out
    data = standings(run, hide_question=hidden_question(run))
    row = next(r for r in data["rows"] if r["token"] == token.pk)
    out.update(
        {
            "score": row["score"],
            "rank": row["rank"],
            "players": len(data["rows"]),
            "last": (
                {
                    "question": data["last_question"],
                    "points": row["last"] or 0,
                    "answered": row["answered_last"],
                }
                if data["last_question"]
                else None
            ),
        }
    )
    return out


def random_name(run, token):
    """The phone's funny name ("Chaotic Capybara"), free in this run."""
    taken = GameEntry.objects.filter(run=run).exclude(token=token).values_list("nickname", flat=True)
    return funny_names.for_token(token.key, taken)


def free_avatar(run):
    """A random avatar nobody in this run has yet (any, once all are taken)."""
    every = avatar_files.slugs()
    if not every:
        return ""
    used = set(GameEntry.objects.filter(run=run).values_list("avatar", flat=True))
    return random.choice([slug for slug in every if slug not in used] or every)


def auto_enter(run, token):
    """Without nickname and avatar choice there is no join screen: the phone
    plays under its random name right away. True if it just joined."""
    settings = options(run.question_set)
    if settings["nicknames"] or settings["avatars"] or not run.is_active:
        return False
    if GameEntry.objects.filter(run=run, token=token).exists():
        return False
    _, error = enter(run, token, "", "")
    return error is None


def enter(run, token, nickname="", avatar=""):
    """Join a game run (or change name/avatar). The nickname counts only if
    the set asks for nicknames (else the random name), the avatar only if it
    allows avatars. Returns (entry, error)."""
    settings = options(run.question_set)
    if settings["avatars"]:
        avatar = avatar if avatar in avatar_files.slugs() else free_avatar(run)
    else:
        avatar = ""
    name = clean_nickname(nickname) if settings["nicknames"] else random_name(run, token)
    if not name:
        return None, "empty"
    taken = (
        GameEntry.objects.filter(run=run, nickname__iexact=name).exclude(token=token).exists()
    )
    if taken:
        return None, "taken"
    try:
        with transaction.atomic():
            entry, _ = GameEntry.objects.update_or_create(
                run=run, token=token, defaults={"nickname": name, "avatar": avatar}
            )
    except IntegrityError:
        return None, "taken"
    return entry, None


def latest_game_run(room, run_id=None):
    runs = Run.objects.filter(question_set__room=room, mode=Run.Mode.LIVE).filter(
        Q(question_set__qb_game__enabled=True)
    )
    if run_id:
        return runs.filter(pk=run_id).select_related("question_set", "active_question").first()
    return (
        runs.exclude(phase=Run.Phase.FINISHED)
        .select_related("question_set", "active_question")
        .order_by("-created_at")
        .first()
    )
