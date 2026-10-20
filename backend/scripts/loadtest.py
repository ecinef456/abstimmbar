# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Load test for the live loop (roadmap M2: ≥ 1000 simulated participants).

Run inside the backend container against the local server:

    docker compose exec backend sh -c "pip install -q aiohttp && \
        python scripts/loadtest.py --participants 1000"

What it does:
1. Creates a dedicated load-test room/set/question and a local superuser
   (ORM), plus a presenter HTTP session via the admin login (ModelBackend).
2. Spawns N participants: join → open SSE stream → wait for "open".
3. Opens the question via the control API, participants vote immediately.
4. Reports join latency, event-fanout spread and vote throughput; cleans up.
"""
import argparse
import asyncio
import json
import os
import random
import statistics
import sys
import time

import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
# Test tool only: fixture setup/teardown does ORM calls from the async main.
os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = "true"
django.setup()

import aiohttp
from django.contrib.auth import get_user_model

from rooms.models import AnswerOption, Question, QuestionSet, Room

USERNAME, PASSWORD = "loadtest-admin", "loadtest-password"


def setup_fixture():
    user, _ = get_user_model().objects.get_or_create(
        username=USERNAME, defaults={"is_staff": True, "is_superuser": True}
    )
    user.is_staff = user.is_superuser = True
    user.set_password(PASSWORD)
    user.save()
    room = Room.objects.create(title="Lasttest")
    room.owners.add(user)
    question_set = QuestionSet.objects.create(room=room, title="Lasttest-Set")
    question = Question.objects.create(
        question_set=question_set, kind=Question.Kind.SINGLE_CHOICE, text="<p>Load?</p>"
    )
    options = [
        AnswerOption.objects.create(question=question, text=t, position=i)
        for i, t in enumerate(["A", "B", "C", "D"])
    ]
    return room, question_set, question, options


async def presenter_login(session, base):
    async with session.get(f"{base}/admin/login/") as response:
        await response.read()
    csrf = session.cookie_jar.filter_cookies(base)["abstimmbar_csrftoken"].value
    async with session.post(
        f"{base}/admin/login/",
        data={"username": USERNAME, "password": PASSWORD, "csrfmiddlewaretoken": csrf},
        headers={"Referer": f"{base}/admin/login/"},
        allow_redirects=False,  # success redirect points at the SPA host
    ) as response:
        assert response.status == 302, response.status


async def presenter_post(session, base, path, payload):
    csrf = session.cookie_jar.filter_cookies(base)["abstimmbar_csrftoken"].value
    async with session.post(
        f"{base}{path}",
        json=payload,
        headers={"X-CSRFToken": csrf, "Referer": f"{base}/"},
    ) as response:
        body = await response.json()
        assert response.status == 200, body
        return body


async def participant(session, base, code, option_ids, stats, stop):
    t0 = time.monotonic()
    async with session.post(f"{base}/api/live/rooms/{code}/join/", json={}) as response:
        token = (await response.json())["token"]
    stats["join_ms"].append((time.monotonic() - t0) * 1000)

    voted = False
    async with session.get(
        f"{base}/api/live/rooms/{code}/stream/",
        timeout=aiohttp.ClientTimeout(total=None, sock_read=None),
    ) as response:
        stats["connected"] += 1
        async for raw in response.content:
            if stop.is_set():
                return
            line = raw.decode().strip()
            if not line.startswith("data: "):
                continue
            state = json.loads(line[6:])
            if state.get("phase") == "open" and not voted:
                stats["open_seen_at"].append(time.monotonic())
                voted = True
                t1 = time.monotonic()
                async with session.post(
                    f"{base}/api/live/rooms/{code}/vote/",
                    json={"token": token, "options": [random.choice(option_ids)]},
                ) as vote_response:
                    stats["vote_ms"].append((time.monotonic() - t1) * 1000)
                    stats["vote_status"][vote_response.status] = (
                        stats["vote_status"].get(vote_response.status, 0) + 1
                    )
                stats["voted"] += 1


def percentile(values, p):
    return statistics.quantiles(values, n=100)[p - 1] if len(values) > 1 else values[0]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--participants", type=int, default=1000)
    parser.add_argument("--base", default="http://localhost:8000")
    args = parser.parse_args()

    room, question_set, question, options = setup_fixture()
    option_ids = [o.pk for o in options]
    print(f"room {room.code}, {args.participants} participants → {args.base}")

    connector = aiohttp.TCPConnector(limit=0)
    stats = {
        "join_ms": [], "vote_ms": [], "open_seen_at": [],
        "connected": 0, "voted": 0, "vote_status": {},
    }
    stop = asyncio.Event()

    try:
        async with aiohttp.ClientSession(connector=connector) as clients, \
                aiohttp.ClientSession() as presenter:
            await presenter_login(presenter, args.base)
            run = await presenter_post(
                presenter, args.base,
                f"/api/question-sets/{question_set.pk}/start-run/", {"existing": "delete"},
            )

            tasks = [
                asyncio.create_task(
                    participant(clients, args.base, room.code, option_ids, stats, stop)
                )
                for _ in range(args.participants)
            ]

            t_connect = time.monotonic()
            while stats["connected"] < args.participants:
                await asyncio.sleep(0.2)
                if time.monotonic() - t_connect > 120:
                    break
            connect_seconds = time.monotonic() - t_connect
            print(f"connected: {stats['connected']} in {connect_seconds:.1f}s")

            t_open = time.monotonic()
            await presenter_post(
                presenter, args.base, f"/api/runs/{run['run']}/control/",
                {"phase": "open", "question": question.pk},
            )
            while stats["voted"] < stats["connected"]:
                await asyncio.sleep(0.2)
                if time.monotonic() - t_open > 120:
                    break
            vote_seconds = time.monotonic() - t_open

            print(f"votes: {stats['voted']} in {vote_seconds:.1f}s "
                  f"({stats['voted'] / max(vote_seconds, 0.001):.0f}/s), "
                  f"statuses: {stats['vote_status']}")
            if stats["open_seen_at"]:
                spread = (max(stats["open_seen_at"]) - min(stats["open_seen_at"])) * 1000
                first_ms = (min(stats["open_seen_at"]) - t_open) * 1000
                print(f"open-event fanout: first after {first_ms:.0f}ms, "
                      f"spread first→last {spread:.0f}ms")
            for name in ("join_ms", "vote_ms"):
                values = stats[name]
                if values:
                    print(f"{name}: median {statistics.median(values):.0f}ms, "
                          f"p95 {percentile(values, 95):.0f}ms, max {max(values):.0f}ms")

            stop.set()
            for task in tasks:
                task.cancel()
    finally:
        room.delete()
        print("cleaned up load-test room")


if __name__ == "__main__":
    asyncio.run(main())
