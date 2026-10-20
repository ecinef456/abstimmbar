# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Live side of the mind-map question kind (stage 1).

All participants build ONE shared tree per run and question. Identical terms
under the same parent (``rooms.mindmap.text_key``) merge into one node whose
count is its number of contributions. Contributions reference only the opaque
participant token (anonymity by design): the token is used for the
per-person cap and for withdrawing one's own term, and is never exposed.

Writes (add/withdraw/seed materialisation) are serialised per run by locking
the Run row, so caps, depth checks and the "nothing hangs below" rule are
race-free; the unique constraints on MindmapNode/MindmapContribution are the
backstop. The tree is built with a bounded number of queries (nodes, counts,
descriptions) and assembled in Python.
"""
from collections import defaultdict

import nh3
from django.core import signing
from django.db import IntegrityError, transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.utils.dateparse import parse_datetime

from common.i18n_fields import translated_map
from rooms.mindmap import (
    MINDMAP_DESCRIPTION_MAX,
    MINDMAP_TEXT_MAX,
    clean_seed,
    normalize_text,
    seed_langs,
    text_key,
)

from .models import (
    MatrixCard,
    MatrixRating,
    MindmapContribution,
    MindmapModerationEntry,
    MindmapNode,
    MindmapPhase,
    MindmapRating,
    Run,
    Vote,
)

MINDMAP_MAX_NODES = 300
MINDMAP_MAX_DESCRIPTIONS = 3
# Mind-map adds/withdrawals coalesce into at most ~1 snapshot per second per
# room (the 300-node tree is the biggest live payload).
BROADCAST_DEBOUNCE = 1.0
ROOT_LABEL_MAX = 80


class MindmapError(Exception):
    """A refused action: ``detail`` + HTTP ``status`` (+ ``extra`` fields for
    the response body, e.g. ``conflict``)."""

    def __init__(self, detail, status=400, **extra):
        super().__init__(detail)
        self.detail = detail
        self.status = status
        self.extra = extra

    def body(self):
        return {"detail": self.detail, **self.extra}


def answered_runs_q(run_ref="pk"):
    """Q for runs that collected answers — votes or mind-map contributions —
    as EXISTS subqueries (no multiplying JOINs, no ``.distinct()`` needed).
    ``run_ref`` is the outer reference to the run id (e.g. ``"runs"`` when
    filtering/annotating question sets)."""
    return (
        Q(Exists(Vote.objects.filter(run=OuterRef(run_ref))))
        | Q(Exists(MindmapContribution.objects.filter(node__run=OuterRef(run_ref))))
        | Q(Exists(MindmapRating.objects.filter(node__run=OuterRef(run_ref))))
        | Q(Exists(MatrixCard.objects.filter(run=OuterRef(run_ref), teacher=False)))
        | Q(Exists(MatrixRating.objects.filter(card__run=OuterRef(run_ref))))
    )


def run_has_contributions(run):
    return MindmapContribution.objects.filter(node__run=run).exists()


def run_has_answers(run):
    """A run "has results": votes, mind-map contributions or ratings (a
    predefined/presenter-added entry can be rated without contributions), or
    participant matrix cards."""
    return (
        run.votes.exists()
        or run_has_contributions(run)
        or MindmapRating.objects.filter(node__run=run).exists()
        or MatrixCard.objects.filter(run=run, teacher=False).exists()
        or MatrixRating.objects.filter(card__run=run).exists()
    )


def contribution_total(run):
    return MindmapContribution.objects.filter(node__run=run).count()


def _lock_run(run):
    # FOR NO KEY UPDATE: serialises mind-map writes per run without blocking
    # inserts of rows that reference the run (votes, nodes) via FK checks.
    Run.objects.select_for_update(no_key=True).filter(pk=run.pk).first()


def is_rating(run, question):
    """True while the question is in its rating stage in this run (see
    ``live.mindmap_rating``): a rating mode is set and the stored stage is
    "rate". Participants then rate entries and cannot add or withdraw terms."""
    return bool(question.mindmap_rating_mode) and MindmapPhase.objects.filter(
        run=run, question=question, stage=MindmapPhase.Stage.RATE
    ).exists()


RATING_IN_PROGRESS = "Rating in progress — no new terms."
MODERATION_WHILE_RATING = "Not possible while rating is in progress."


def _refuse_while_rating(run, question):
    """Presenter restructuring (add/delete/merge/move/rename/undo) would
    shift entries under the raters' fingers — refused during the rating
    stage (hide/unhide stay allowed). Call under the run lock."""
    if is_rating(run, question):
        raise MindmapError(MODERATION_WHILE_RATING, 409)


def root_label(question):
    """{de, en} root label: the authored ``mindmap_root``, else the plain
    (markup-free, shortened) question text."""
    label = translated_map(question, "mindmap_root")
    if any(label.values()):
        return label
    result = {}
    for lang, html in translated_map(question, "text").items():
        plain = " ".join(nh3.clean(html or "", tags=set()).split())
        if len(plain) > ROOT_LABEL_MAX:
            plain = plain[: ROOT_LABEL_MAX - 1].rstrip() + "…"
        result[lang] = plain
    return result


def ensure_seed(run, question):
    """Materialise the question's predefined branches for this run, once.

    Idempotent: a run that already has seeded nodes is left alone (later
    edits of the seed only affect new runs). Serialised via the Run row lock.
    """
    if not question.mindmap_seed:
        return
    if MindmapNode.objects.filter(run=run, question=question, seeded=True).exists():
        return
    seed = clean_seed(question.mindmap_seed, question.mindmap_depth, strict=False)
    if not seed:
        return
    with transaction.atomic():
        _lock_run(run)
        if MindmapNode.objects.filter(run=run, question=question, seeded=True).exists():
            return

        canonical, _ = seed_langs()

        def walk(entries, parent):
            for entry in entries:
                text = entry["text"][canonical]
                description = entry["description"][canonical]
                i18n = {"text": entry["text"], "description": entry["description"]}
                key = text_key(text)
                node = MindmapNode.objects.filter(
                    run=run, question=question, parent=parent, text_key=key
                ).first()
                if node is None:
                    node = MindmapNode.objects.create(
                        run=run, question=question, parent=parent,
                        text=text, text_key=key, description=description,
                        seeded=True, seed_i18n=i18n,
                    )
                else:
                    node.seeded = True
                    node.description = node.description or description
                    node.seed_i18n = i18n
                    node.save(update_fields=["seeded", "description", "seed_i18n"])
                walk(entry["children"], node)

        walk(seed, None)


def build_tree(run, question, *, presenter):
    """The mind-map payload for one run/question.

    Participant form (``presenter=False``): hidden nodes and their subtrees
    are left out entirely. Presenter form: every node, each with ``hidden``
    (only the explicitly hidden node is flagged; its subtree is implicitly
    hidden). ``total`` = number of nodes in the returned tree.
    """
    rows = list(
        MindmapNode.objects.filter(run=run, question=question)
        .order_by("created_at", "pk")
        .values(
            "id", "parent_id", "text", "text_key", "description", "seeded",
            "seed_i18n", "hidden", "teacher",
        )
    )
    ids = [row["id"] for row in rows]
    counts = {}
    descriptions = defaultdict(list)
    if ids:
        counts = dict(
            MindmapContribution.objects.filter(node_id__in=ids)
            .order_by()
            .values_list("node_id")
            .annotate(n=Count("id"))
        )
        if question.mindmap_descriptions:
            for row in rows:
                if row["description"]:
                    descriptions[row["id"]].append(row["description"])
            for node_id, text in (
                MindmapContribution.objects.filter(node_id__in=ids)
                .exclude(description="")
                .order_by("created_at", "pk")
                .values_list("node_id", "description")
            ):
                descriptions[node_id].append(text)

    children = defaultdict(list)
    for row in rows:
        children[row["parent_id"]].append(row)

    total = 0

    def unique_descriptions(node_id):
        seen, result = set(), []
        for text in descriptions.get(node_id, ()):
            key = text.casefold()
            if key not in seen:
                seen.add(key)
                result.append(text)
            if len(result) >= MINDMAP_MAX_DESCRIPTIONS:
                break
        return result

    def walk(parent_id):
        nonlocal total
        result = []
        for row in children.get(parent_id, ()):
            if row["hidden"] and not presenter:
                continue
            total += 1
            node = {
                "id": row["id"],
                "text": row["text"],
                "count": counts.get(row["id"], 0),
                "descriptions": unique_descriptions(row["id"]),
                "seeded": row["seeded"],
            }
            if row["teacher"]:
                # Presenter-added (stage 2): protected like a seeded node.
                # Only sent when set, to keep the broadcast small.
                node["teacher"] = True
            if row["seeded"]:
                _add_seed_i18n(node, row["seed_i18n"], row["description"])
            if presenter:
                # Presenter only: merge key (duplicate highlighting on the
                # beamer) and moderation state. Kept out of the participant
                # broadcast to keep it small.
                node["key"] = row["text_key"]
                node["hidden"] = row["hidden"]
            node["children"] = walk(row["id"])
            result.append(node)
        return result

    nodes = walk(None)
    return {
        "root": {"label": root_label(question)},
        "depth": question.mindmap_depth,
        "max_per_person": question.mindmap_max_per_person,
        "descriptions": question.mindmap_descriptions,
        "highlight_duplicates": question.mindmap_highlight_duplicates,
        "max_nodes": MINDMAP_MAX_NODES,
        "total": total,
        "nodes": nodes,
    }


def _add_seed_i18n(node, i18n, description):
    """Seeded nodes: add the bilingual ``text_i18n`` map and — when the first
    shown description is the seed's — ``description_i18n`` (resolved
    client-side; ``text``/``descriptions`` stay canonical). Nodes seeded
    before bilingual seeds fall back to the canonical text."""
    canonical, langs = seed_langs()
    i18n = i18n or {}
    text = i18n.get("text") or {canonical: node["text"]}
    node["text_i18n"] = {lang: text.get(lang, "") for lang in langs}
    if description and node["descriptions"][:1] == [description]:
        desc = i18n.get("description") or {canonical: description}
        node["description_i18n"] = {lang: desc.get(lang, "") for lang in langs}


def preview_tree(question):
    """Participant-form tree of the predefined branches without a run — for
    the editor preview (#74). Nothing is stored: ids are negative and local."""
    seed = clean_seed(question.mindmap_seed, question.mindmap_depth, strict=False)
    canonical, _ = seed_langs()
    next_id = 0

    def walk(entries):
        nonlocal next_id
        result = []
        for entry in entries:
            next_id -= 1
            description = entry["description"][canonical]
            node = {
                "id": next_id,
                "text": entry["text"][canonical],
                "count": 0,
                "descriptions": (
                    [description] if question.mindmap_descriptions and description else []
                ),
                "seeded": True,
            }
            _add_seed_i18n(node, entry, description)
            node["children"] = walk(entry["children"])
            result.append(node)
        return result

    nodes = walk(seed)
    return {
        "root": {"label": root_label(question)},
        "depth": question.mindmap_depth,
        "max_per_person": question.mindmap_max_per_person,
        "descriptions": question.mindmap_descriptions,
        "highlight_duplicates": question.mindmap_highlight_duplicates,
        "max_nodes": MINDMAP_MAX_NODES,
        "total": -next_id,
        "nodes": nodes,
    }


def contributor_count(run, question):
    """Distinct participants who contributed (the "votes" of a mind map)."""
    return (
        MindmapContribution.objects.filter(node__run=run, node__question=question)
        .values("token")
        .distinct()
        .count()
    )


def contributor_tokens(run, question):
    """Ids of the distinct participant tokens that contributed a term (hidden
    ones included, like :func:`contributor_count`)."""
    return set(
        MindmapContribution.objects.filter(node__run=run, node__question=question)
        .values_list("token_id", flat=True)
        .distinct()
    )


def participant_contribution_count(run, question):
    """Participants' contributions to visible terms (nothing below a hidden
    term) — the quota used, i.e. the "items" of the beamer's progress pill
    while collecting. Two people adding the same term count twice, and a
    contribution to a seeded/presenter term counts like any other, exactly
    as ``mindmap_max_per_person`` charges them."""
    tree = _load_tree(run, question)
    visible = {node_id for node_id in tree if not _effectively_hidden(tree, node_id)}
    return sum(
        1
        for node_id in MindmapContribution.objects.filter(
            node__run=run, node__question=question
        ).values_list("node_id", flat=True)
        if node_id in visible
    )


def own_node_ids(run, question, token):
    return list(
        MindmapContribution.objects.filter(
            node__run=run, node__question=question, token=token
        )
        .order_by("created_at", "pk")
        .values_list("node_id", flat=True)
    )


def _parse_id(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def add_term(run, question, token, parent, text, description=""):
    """Add (or merge) a participant's term. Returns ``(node, merged)``;
    raises MindmapError."""
    text = normalize_text(text)
    if not text:
        raise MindmapError("Empty term.")
    if len(text) > MINDMAP_TEXT_MAX:
        raise MindmapError("Term too long.")
    description = normalize_text(description) if question.mindmap_descriptions else ""
    if len(description) > MINDMAP_DESCRIPTION_MAX:
        raise MindmapError("Description too long.")
    parent_id = None
    if parent is not None:
        parent_id = _parse_id(parent)
        if parent_id is None:
            raise MindmapError("Unknown parent.")
    key = text_key(text)

    ensure_seed(run, question)
    with transaction.atomic():
        _lock_run(run)
        if is_rating(run, question):
            raise MindmapError(RATING_IN_PROGRESS, 409)
        tree = {
            node_id: (pid, hidden)
            for node_id, pid, hidden in MindmapNode.objects.filter(
                run=run, question=question
            ).values_list("id", "parent_id", "hidden")
        }
        level = 1
        if parent_id is not None:
            # The parent and all its ancestors must exist and be visible.
            current, guard = parent_id, 0
            while current is not None:
                if current not in tree or tree[current][1] or guard > 50:
                    raise MindmapError("Unknown parent.")
                level += 1
                current = tree[current][0]
                guard += 1
        if level > question.mindmap_depth:
            raise MindmapError("Maximum depth reached.")

        node = MindmapNode.objects.filter(
            run=run, question=question, parent_id=parent_id, text_key=key
        ).first()
        if node is not None and node.contributions.filter(token=token).exists():
            raise MindmapError("Already added.", 409)
        cap = question.mindmap_max_per_person
        if cap and MindmapContribution.objects.filter(
            node__run=run, node__question=question, token=token
        ).count() >= cap:
            raise MindmapError("Maximum reached.", 409)
        merged = node is not None
        if node is None:
            if len(tree) >= MINDMAP_MAX_NODES:
                raise MindmapError("The mind map is full.", 409)
            node = MindmapNode.objects.create(
                run=run, question=question, parent_id=parent_id, text=text, text_key=key
            )
        try:
            with transaction.atomic():
                MindmapContribution.objects.create(
                    node=node, token=token, description=description
                )
        except IntegrityError as error:
            raise MindmapError("Already added.", 409) from error
    return node, merged


def remove_term(run, question, token, node):
    """Withdraw the caller's own contribution. Returns True when the node
    itself was deleted (last contribution of a node that is neither seeded
    nor presenter-added)."""
    node_id = _parse_id(node)
    with transaction.atomic():
        _lock_run(run)
        if is_rating(run, question):
            raise MindmapError("Rating in progress — terms cannot be withdrawn.", 409)
        node = (
            MindmapNode.objects.filter(pk=node_id, run=run, question=question).first()
            if node_id is not None
            else None
        )
        if node is None:
            raise MindmapError("Unknown term.", 404)
        contribution = node.contributions.filter(token=token).first()
        if contribution is None:
            raise MindmapError("Not your term.", 403)
        if node.children.exists():
            raise MindmapError("Terms hang below this one.", 409)
        last = (
            not (node.seeded or node.teacher)
            and not node.contributions.exclude(pk=contribution.pk).exists()
        )
        if last and node.ratings.exists():
            # Withdrawing would delete the entry together with other
            # participants' ratings.
            raise MindmapError("This term has already been rated.", 409)
        contribution.delete()
        if last:
            node.delete()
            return True
    return False


def set_hidden(run, question, node, hidden):
    """Presenter moderation: hide/unhide a node (its subtree with it).
    Returns False for an unknown node."""
    node_id = _parse_id(node)
    if node_id is None:
        return False
    return bool(
        MindmapNode.objects.filter(pk=node_id, run=run, question=question).update(
            hidden=bool(hidden)
        )
    )


# --- Stage 2: presenter moderation (owner-only; views check ownership) -----
#
# All writes run under the run lock and validate everything before the first
# side effect. Merges and renames hand back an opaque, signed ``undo`` string
# (``django.core.signing``: tamper-proof, bound to run + question, valid for
# UNDO_MAX_AGE) that ``restore`` replays exactly — or refuses with 409 when the
# map changed in a way that makes exact restoration impossible.
#
# The blob is SIGNED, NOT ENCRYPTED: its content is readable by whoever holds
# it — only the run's owner, who receives it from these owner-only endpoints.
# It holds node data, contribution ids and timestamps but never participant
# tokens. A duplicate contribution dropped by a merge is recorded via its
# "twin" (the target's contribution of the same participant), whose token is
# reused on restore. Restoring a participant's contribution needs *some*
# reference to that participant; the twin id is the weakest one available: it
# only says "the same (unknown) person contributed both terms" — which the
# owner already sees from the merged count (distinct contributors) — and
# contribution ids appear in no other payload.

UNDO_SALT = "live.mindmap.undo"
UNDO_MAX_AGE = 24 * 60 * 60  # seconds
_MAX_LEVELS = 64


def _clean_term(text):
    text = normalize_text(text)
    if not text:
        raise MindmapError("Empty term.")
    if len(text) > MINDMAP_TEXT_MAX:
        raise MindmapError("Term too long.")
    return text


def _load_tree(run, question):
    """{id: (parent_id, hidden)} of the whole map (call under the lock)."""
    return {
        node_id: (pid, hidden)
        for node_id, pid, hidden in MindmapNode.objects.filter(
            run=run, question=question
        ).values_list("id", "parent_id", "hidden")
    }


def _path(tree, node_id):
    """The node and all its ancestors (bottom-up); [] for the root (None)."""
    path, current = [], node_id
    while current is not None:
        if len(path) > _MAX_LEVELS:
            raise MindmapError("Corrupt mind map.", 409)
        path.append(current)
        current = tree[current][0]
    return path


def _level(tree, node_id):
    """Level of a node (main branches = 1; the root = 0)."""
    return len(_path(tree, node_id))


def _effectively_hidden(tree, node_id):
    return any(tree[ancestor][1] for ancestor in _path(tree, node_id))


def _height(tree, node_id):
    """Levels of the subtree rooted at ``node_id`` (a leaf = 1)."""
    children = defaultdict(list)
    for nid, (pid, _hidden) in tree.items():
        children[pid].append(nid)

    def walk(nid, guard):
        if guard > _MAX_LEVELS:
            raise MindmapError("Corrupt mind map.", 409)
        return 1 + max((walk(c, guard + 1) for c in children[nid]), default=0)

    return walk(node_id, 0)


def _node_or_404(tree, node_id, detail="Unknown term."):
    if node_id not in tree:
        raise MindmapError(detail, 404)
    return node_id


def _check_add(tree, question, parent_id):
    """A new term below ``parent_id`` (None = main branch): the parent exists
    and is visible, the new level fits the depth."""
    if parent_id is not None:
        _node_or_404(tree, parent_id, "Unknown parent.")
        if _effectively_hidden(tree, parent_id):
            raise MindmapError("This branch is hidden.", 409)
    if _level(tree, parent_id) + 1 > question.mindmap_depth:
        raise MindmapError("Maximum depth reached.")


def teacher_add(run, question, parent_id, text, description=""):
    """The presenter adds a term (no contribution, no quota). A term that
    already exists under ``parent_id`` is returned as is. ``(node, merged)``."""
    text = _clean_term(text)
    description = normalize_text(description) if question.mindmap_descriptions else ""
    if len(description) > MINDMAP_DESCRIPTION_MAX:
        raise MindmapError("Description too long.")
    key = text_key(text)
    ensure_seed(run, question)
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        tree = _load_tree(run, question)
        _check_add(tree, question, parent_id)
        node = MindmapNode.objects.filter(
            run=run, question=question, parent_id=parent_id, text_key=key
        ).first()
        if node is not None:
            if tree[node.pk][1]:
                raise MindmapError(
                    "This term already exists there but is hidden.",
                    409, conflict=node.pk, hidden=True,
                )
            return node, True
        if len(tree) >= MINDMAP_MAX_NODES:
            raise MindmapError("The mind map is full.", 409)
        node = MindmapNode.objects.create(
            run=run, question=question, parent_id=parent_id, text=text,
            text_key=key, description=description, teacher=True,
        )
    return node, False


def teacher_delete(run, question, node_id):
    """Exact undo of a presenter's add: delete a presenter-added term that
    nothing hangs below and nobody has joined."""
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        node = MindmapNode.objects.filter(pk=node_id, run=run, question=question).first()
        if node is None:
            raise MindmapError("Unknown term.", 404)
        if not node.teacher or node.seeded:
            raise MindmapError("Only terms added by the presenter can be deleted.", 409)
        if node.children.exists():
            raise MindmapError("Terms hang below this one.", 409)
        if node.contributions.exists():
            raise MindmapError("Participants have added this term too.", 409)
        if node.ratings.exists():
            raise MindmapError("Participants have rated this term.", 409)
        node.delete()


def _sign(run, question, data):
    return signing.dumps(
        {"run": run.pk, "question": question.pk, **data}, salt=UNDO_SALT, compress=True
    )


def _snapshot(node):
    return {
        "id": node.pk,
        "parent": node.parent_id,
        "text": node.text,
        "text_key": node.text_key,
        "description": node.description,
        "seeded": node.seeded,
        "teacher": node.teacher,
        "seed_i18n": node.seed_i18n,
        "hidden": node.hidden,
        "created_at": node.created_at.isoformat(),
    }


def _term(node):
    """A term in a moderation-log label (``live.mindmap_log``): its text at
    the time of the action — plus, for a seeded node, its ``text_i18n`` map
    like in the tree. None = the main branch (no parent)."""
    if node is None:
        return None
    term = {"text": node.text}
    if node.seeded:
        canonical, langs = seed_langs()
        text = (node.seed_i18n or {}).get("text") or {canonical: node.text}
        term["text_i18n"] = {lang: text.get(lang, "") for lang in langs}
    return term


def _log(run, question, kind, label, undo):
    """Record a moderation-log entry (under the run lock); its id."""
    return MindmapModerationEntry.objects.create(
        run=run, question=question, kind=kind, label=label, undo=undo
    ).pk


def _mark_reset(run, question, kinds, undo):
    """The step with this undo data was undone (the beamer's top undo):
    mark its active log entry reset."""
    MindmapModerationEntry.objects.filter(
        run=run, question=question, kind__in=kinds, undo=undo,
        state=MindmapModerationEntry.State.ACTIVE,
    ).update(state=MindmapModerationEntry.State.RESET)


def _combine_ratings(question, target_value, source_value):
    """A participant rated both merged entries: points add up (capped at one
    when only one point per entry is allowed); plus/minus keeps the target's."""
    if question.mindmap_rating_mode == "points":
        combined = target_value + source_value
        return combined if question.mindmap_rating_multi else min(combined, 1)
    return target_value


def _merge(source, target, question):
    """Merge ``source`` into ``target`` (validated by the caller, under the
    lock) and return the undo record. Same-named children merge recursively;
    contributions move over, one per participant; ratings move over too
    (combined per participant, ``_combine_ratings``)."""
    undo = {
        "source": _snapshot(source),
        "target": {
            "id": target.pk,
            "seeded": target.seeded,
            "teacher": target.teacher,
            "description": target.description,
            "seed_i18n": target.seed_i18n,
        },
        "moved": [],
        "dropped": [],
        "children": [],
        "nested": [],
        # Ratings (rating phase): moved ids, and per participant who rated
        # both entries the source value plus the target rating before/after
        # combining (``twin`` = the target's rating id; no token).
        "rating_moved": [],
        "rating_dropped": [],
    }
    twins = {child.text_key: child for child in target.children.all()}
    for child in source.children.order_by("created_at", "pk"):
        twin = twins.get(child.text_key)
        if twin is not None:
            undo["nested"].append(_merge(child, twin, question))
        else:
            undo["children"].append(child.pk)
    if undo["children"]:
        MindmapNode.objects.filter(pk__in=undo["children"]).update(parent=target)

    target_tokens = dict(target.contributions.values_list("token_id", "id"))
    dropped_ids = []
    for contribution in source.contributions.order_by("created_at", "pk"):
        twin_id = target_tokens.get(contribution.token_id)
        if twin_id is None:
            undo["moved"].append(contribution.pk)
        else:
            dropped_ids.append(contribution.pk)
            undo["dropped"].append({
                "twin": twin_id,
                "description": contribution.description,
                "created_at": contribution.created_at.isoformat(),
            })
    if undo["moved"]:
        MindmapContribution.objects.filter(pk__in=undo["moved"]).update(node=target)
    if dropped_ids:
        MindmapContribution.objects.filter(pk__in=dropped_ids).delete()

    target_ratings = {
        token_id: (rating_id, value)
        for rating_id, token_id, value in target.ratings.values_list("id", "token_id", "value")
    }
    dropped_ratings = []
    for rating in source.ratings.order_by("pk"):
        twin = target_ratings.get(rating.token_id)
        if twin is None:
            undo["rating_moved"].append(rating.pk)
            continue
        twin_id, twin_value = twin
        combined = _combine_ratings(question, twin_value, rating.value)
        dropped_ratings.append(rating.pk)
        undo["rating_dropped"].append(
            {"twin": twin_id, "value": rating.value,
             "twin_value": twin_value, "combined": combined}
        )
        if combined != twin_value:
            MindmapRating.objects.filter(pk=twin_id).update(value=combined)
    if undo["rating_moved"]:
        MindmapRating.objects.filter(pk__in=undo["rating_moved"]).update(node=target)
    if dropped_ratings:
        MindmapRating.objects.filter(pk__in=dropped_ratings).delete()

    # The merged node inherits the source's protection (and, if it has none,
    # its predefined description) — keeps ensure_seed from re-creating a
    # merged-away seed node and participants from deleting it.
    fields = []
    if source.seeded and not target.seeded:
        target.seeded = True
        fields.append("seeded")
    if source.teacher and not target.teacher:
        target.teacher = True
        fields.append("teacher")
    if source.description and not target.description:
        target.description = source.description
        fields.append("description")
        desc_i18n = (source.seed_i18n or {}).get("description")
        if desc_i18n and not (target.seed_i18n or {}).get("description"):
            target.seed_i18n = {**(target.seed_i18n or {}), "description": desc_i18n}
            fields.append("seed_i18n")
    if fields:
        target.save(update_fields=fields)
    source.delete()
    return undo


def _db_children(node_id):
    """``[(text_key, id, hidden)]`` of a node's children (database)."""
    return list(
        MindmapNode.objects.filter(parent_id=node_id).values_list("text_key", "id", "hidden")
    )


def _check_nested_hidden(source_id, target_id, children_of=_db_children):
    """Same-named children merge recursively; a pair whose hidden state
    differs would re-expose moderated content (or hide live content), so the
    whole merge is refused. ``children_of`` reads ``[(text_key, id, hidden)]``
    (the database, or the AI simulation's in-memory tree)."""
    pairs = [(source_id, target_id)]
    while pairs:
        source, target = pairs.pop()
        twins, hidden = {}, {}
        for key, child, child_hidden in children_of(target):
            twins[key] = child
            hidden[child] = child_hidden
        for key, child, child_hidden in children_of(source):
            twin = twins.get(key)
            if twin is None:
                continue
            if hidden[twin] != child_hidden:
                raise MindmapError(
                    "A sub-term with the same name is hidden — please show it first.",
                    409,
                )
            pairs.append((child, twin))


def _check_merge(tree, question, source_id, target_id, children_of=_db_children):
    _node_or_404(tree, source_id)
    _node_or_404(tree, target_id)
    if source_id == target_id:
        raise MindmapError("A term cannot be merged with itself.")
    if source_id in _path(tree, target_id) or target_id in _path(tree, source_id):
        raise MindmapError("A term cannot be merged with its own branch.", 409)
    if _effectively_hidden(tree, source_id) or _effectively_hidden(tree, target_id):
        raise MindmapError("This branch is hidden.", 409)
    if _level(tree, target_id) + _height(tree, source_id) - 1 > question.mindmap_depth:
        raise MindmapError("Maximum depth reached.", 409)
    _check_nested_hidden(source_id, target_id, children_of)


def merge_nodes(run, question, source_id, target_id, *, log=False):
    """Merge ``source`` into ``target``; returns the signed undo string —
    with ``log``, ``(undo, log entry id)``."""
    ensure_seed(run, question)
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        _check_merge(_load_tree(run, question), question, source_id, target_id)
        source = MindmapNode.objects.get(pk=source_id)
        target = MindmapNode.objects.get(pk=target_id)
        label = {"source": _term(source), "target": _term(target)}
        blob = _sign(run, question, {"op": "merge", "merge": _merge(source, target, question)})
        if log:
            return blob, _log(run, question, "merge", label, blob)
    return blob


def _check_move(tree, question, node_id, parent_id):
    """Moving ``node_id`` below ``parent_id`` (None = main branch): returns
    the old parent. Not checked here: the name clash at the destination
    (callers look up keys) — and a move to the same parent is a no-op."""
    _node_or_404(tree, node_id)
    old_parent = tree[node_id][0]
    if parent_id is not None:
        _node_or_404(tree, parent_id, "Unknown parent.")
        if node_id in _path(tree, parent_id):
            raise MindmapError("A term cannot be moved into its own branch.", 409)
        if _effectively_hidden(tree, parent_id):
            raise MindmapError("This branch is hidden.", 409)
    if parent_id != old_parent and (
        _level(tree, parent_id) + _height(tree, node_id) > question.mindmap_depth
    ):
        raise MindmapError("Maximum depth reached.", 409)
    return old_parent


def move_node(run, question, node_id, parent_id, *, log=False):
    """Re-attach a node (with its subtree) below ``parent_id`` (None = main
    branch). Returns the plain undo ``{node, parent}`` (the old parent) —
    with ``log``, ``(undo, log entry id or None)``: a move that exactly
    reverses the term's newest active logged move (the beamer's top undo of
    it) marks that entry reset instead of logging a new one; a no-op move is
    not logged."""
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        tree = _load_tree(run, question)
        old_parent = _check_move(tree, question, node_id, parent_id)
        undo = {"node": node_id, "parent": old_parent}
        if parent_id == old_parent:
            return (undo, None) if log else undo
        node = MindmapNode.objects.get(pk=node_id)
        clash = (
            MindmapNode.objects.filter(
                run=run, question=question, parent_id=parent_id, text_key=node.text_key
            )
            .exclude(pk=node_id)
            .values_list("pk", flat=True)
            .first()
        )
        if clash is not None:
            raise MindmapError(
                "A term with this name already exists there — merge instead.",
                409, conflict=clash,
            )
        node.parent_id = parent_id
        node.save(update_fields=["parent"])
        if log:
            return undo, _log_move(run, question, node, old_parent, parent_id)
    return undo


def _log_move(run, question, node, old_parent, parent_id):
    """Log a done move (see ``move_node``); the new entry id or None."""
    newest = (
        MindmapModerationEntry.objects.filter(
            run=run, question=question, kind="move", undo__node=node.pk,
            state=MindmapModerationEntry.State.ACTIVE,
        )
        .order_by("-created_at", "-pk")
        .first()
    )
    if newest is not None and (
        newest.undo.get("to") == old_parent and newest.undo["parent"] == parent_id
    ):
        MindmapModerationEntry.objects.filter(pk=newest.pk).update(
            state=MindmapModerationEntry.State.RESET
        )
        return None
    places = MindmapNode.objects.in_bulk([p for p in (old_parent, parent_id) if p])
    label = {
        "node": _term(node),
        "from": _term(places.get(old_parent)),
        "to": _term(places.get(parent_id)),
    }
    undo = {"node": node.pk, "parent": old_parent, "to": parent_id}
    return _log(run, question, "move", label, undo)


def rename_node(run, question, node_id, text, *, log=False):
    """Rename a term. A name clash with a sibling merges into that sibling.
    Returns ``(node_id, merged, signed undo)`` — with ``log``, plus the log
    entry id (a rename into a sibling is logged as a merge)."""
    text = _clean_term(text)
    key = text_key(text)
    ensure_seed(run, question)
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        tree = _load_tree(run, question)
        _node_or_404(tree, node_id)
        node = MindmapNode.objects.get(pk=node_id)
        clash = (
            MindmapNode.objects.filter(
                run=run, question=question, parent_id=node.parent_id, text_key=key
            )
            .exclude(pk=node_id)
            .first()
        )
        old_term = _term(node)
        if clash is not None:
            _check_merge(tree, question, node_id, clash.pk)
            label = {"source": old_term, "target": _term(clash)}
            undo = _merge(node, clash, question)
            blob = _sign(run, question, {"op": "merge", "merge": undo})
            if log:
                return clash.pk, True, blob, _log(run, question, "merge", label, blob)
            return clash.pk, True, blob
        undo = {
            "op": "rename",
            "node": node.pk,
            "text": node.text,
            "text_key": node.text_key,
            "seed_i18n": node.seed_i18n,
            "new_key": key,
        }
        node.text = text
        node.text_key = key
        fields = ["text", "text_key"]
        if node.seeded:
            # The predefined translations no longer match: show the new
            # canonical term in every language (undo restores them).
            canonical, langs = seed_langs()
            node.seed_i18n = {
                **(node.seed_i18n or {}),
                "text": {lang: text if lang == canonical else "" for lang in langs},
            }
            fields.append("seed_i18n")
        node.save(update_fields=fields)
        blob = _sign(run, question, undo)
        if log:
            label = {"old": old_term, "new": _term(node)}
            return node.pk, False, blob, _log(run, question, "rename", label, blob)
    return node.pk, False, blob


def _unsign(run, question, blob, max_age=UNDO_MAX_AGE):
    """The signed undo data (signature and run/question binding checked);
    ``max_age=None`` skips the expiry — only for undo data kept on the
    server (the moderation log), never for a blob handed in by a client."""
    if not isinstance(blob, str):
        raise MindmapError("Invalid undo data.")
    try:
        data = signing.loads(blob, salt=UNDO_SALT, max_age=max_age)
    except signing.SignatureExpired as error:
        raise MindmapError("This undo step has expired.", 409) from error
    except signing.BadSignature as error:
        raise MindmapError("Invalid undo data.") from error
    if (
        not isinstance(data, dict)
        or data.get("run") != run.pk
        or data.get("question") != question.pk
        or data.get("op") not in ("merge", "rename")
    ):
        raise MindmapError("Invalid undo data.")
    return data


_CHANGED = "The mind map has changed in the meantime — this can no longer be undone."


def _restore_merge(run, question, undo):
    src = undo["source"]
    target = MindmapNode.objects.filter(
        pk=undo["target"]["id"], run=run, question=question
    ).first()
    if target is None or MindmapNode.objects.filter(pk=src["id"]).exists():
        raise MindmapError(_CHANGED, 409)
    if src["parent"] is not None and not MindmapNode.objects.filter(
        pk=src["parent"], run=run, question=question
    ).exists():
        raise MindmapError(_CHANGED, 409)
    if MindmapNode.objects.filter(
        run=run, question=question, parent_id=src["parent"], text_key=src["text_key"]
    ).exists():
        raise MindmapError(_CHANGED, 409)
    node = MindmapNode(
        id=src["id"], run=run, question=question, parent_id=src["parent"],
        text=src["text"], text_key=src["text_key"], description=src["description"],
        seeded=src["seeded"], teacher=src["teacher"], seed_i18n=src["seed_i18n"],
        hidden=src["hidden"],
    )
    node.save(force_insert=True)
    MindmapNode.objects.filter(pk=node.pk).update(created_at=parse_datetime(src["created_at"]))

    for nested in undo["nested"]:
        _restore_merge(run, question, nested)

    children = undo["children"]
    if children and MindmapNode.objects.filter(
        pk__in=children, parent=target
    ).update(parent=node) != len(children):
        raise MindmapError(_CHANGED, 409)

    moved = undo["moved"]
    if moved and MindmapContribution.objects.filter(
        pk__in=moved, node=target
    ).update(node=node) != len(moved):
        raise MindmapError(_CHANGED, 409)

    twins = dict(
        MindmapContribution.objects.filter(
            pk__in=[d["twin"] for d in undo["dropped"]], node=target
        ).values_list("pk", "token_id")
    )
    for dropped in undo["dropped"]:
        token_id = twins.get(dropped["twin"])
        if token_id is None:
            raise MindmapError(_CHANGED, 409)
        contribution = MindmapContribution.objects.create(
            node=node, token_id=token_id, description=dropped["description"]
        )
        MindmapContribution.objects.filter(pk=contribution.pk).update(
            created_at=parse_datetime(dropped["created_at"])
        )

    # Ratings (blobs signed before the rating phase existed carry none).
    rating_moved = undo.get("rating_moved", [])
    if rating_moved and MindmapRating.objects.filter(
        pk__in=rating_moved, node=target
    ).update(node=node) != len(rating_moved):
        raise MindmapError(_CHANGED, 409)
    for dropped in undo.get("rating_dropped", []):
        twin = MindmapRating.objects.filter(pk=dropped["twin"], node=target).first()
        if twin is None or twin.value != dropped["combined"]:
            # The participant changed the combined rating since: restoring
            # would overwrite it.
            raise MindmapError(_CHANGED, 409)
        MindmapRating.objects.create(node=node, token_id=twin.token_id, value=dropped["value"])
        if twin.value != dropped["twin_value"]:
            MindmapRating.objects.filter(pk=twin.pk).update(value=dropped["twin_value"])

    flags = undo["target"]
    MindmapNode.objects.filter(pk=target.pk).update(
        seeded=flags["seeded"], teacher=flags["teacher"],
        description=flags["description"], seed_i18n=flags["seed_i18n"],
    )


def _restore_rename(run, question, undo):
    node = MindmapNode.objects.filter(pk=undo["node"], run=run, question=question).first()
    if node is None or node.text_key != undo["new_key"]:
        raise MindmapError(_CHANGED, 409)
    if (
        MindmapNode.objects.filter(
            run=run, question=question, parent_id=node.parent_id, text_key=undo["text_key"]
        )
        .exclude(pk=node.pk)
        .exists()
    ):
        raise MindmapError(_CHANGED, 409)
    node.text = undo["text"]
    node.text_key = undo["text_key"]
    node.seed_i18n = undo["seed_i18n"]
    node.save(update_fields=["text", "text_key", "seed_i18n"])


def _check_restored_tree(tree, depth):
    """After a restore: no cycle (a later move may have put an original
    parent below a re-parented child) and every node within the depth."""
    for node_id in tree:
        current, level = node_id, 0
        while current is not None:
            level += 1
            if level > depth or current not in tree:
                raise MindmapError(_CHANGED, 409)
            current = tree[current][0]


def restore(run, question, blob, *, max_age=UNDO_MAX_AGE):
    """Undo a merge or rename from its signed ``undo`` string — all or
    nothing (409 + rollback when the map changed in between).

    Intentionally bypasses the per-person quota and the total node cap: it
    puts back exactly what was there before the merge/rename."""
    data = _unsign(run, question, blob, max_age)
    try:
        with transaction.atomic():
            _lock_run(run)
            _refuse_while_rating(run, question)
            if data["op"] == "merge":
                _restore_merge(run, question, data["merge"])
            else:
                _restore_rename(run, question, data)
            # level > depth also catches cycles (their walk never ends).
            _check_restored_tree(_load_tree(run, question), question.mindmap_depth)
            _mark_reset(run, question, ("merge", "rename"), blob)
    except IntegrityError as error:
        raise MindmapError(_CHANGED, 409) from error


def csv_rows(tree):
    """``(path, count, node id)`` per visible node, depth-first
    ("Wind > Rotor")."""
    rows = []

    def walk(nodes, prefix):
        for node in nodes:
            path = f"{prefix} > {node['text']}" if prefix else node["text"]
            rows.append((path, node["count"], node["id"]))
            walk(node["children"], path)

    walk(tree["nodes"], "")
    return rows


# --- Stage 3: AI optimisation (live/ai_mindmap.py builds the prompt) --------
#
# The LLM proposes a list of operations (merge / rename / add / move). They
# are checked one by one, in order, against an in-memory copy of the map
# (``_SimTree``) with the SAME rule helpers as the manual moderation above
# (``_check_add``, ``_check_merge``, ``_check_move``, ``_clean_term``) plus the
# AI-only rules (``_check_ai_op``): nothing is deleted or hidden, hidden
# branches stay untouched, presenter-added and predefined terms ("fixed") are
# never merged away, renamed or moved. Unfit operations drop out silently
# (counted). Applying re-checks every selected operation against the live map
# under the run lock and runs it through the manual primitives, collecting
# their undo data; operations that no longer fit are skipped (counted).

AI_OP_TYPES = ("merge", "rename", "add", "move")
AI_OPS_MAX = 100
PROPOSAL_SALT = "live.mindmap.ai-proposal"


def ai_settings(question):
    """The question's AI optimisation settings (``target_lang`` resolved to
    the canonical content language when blank)."""
    canonical, _ = seed_langs()
    return {
        "merge": question.mindmap_ai_merge,
        "translate": question.mindmap_ai_translate,
        "target_lang": question.mindmap_ai_target_lang or canonical,
        "restructure": question.mindmap_ai_restructure,
    }


def _op_enabled(op_type, options):
    if op_type == "merge":
        return bool(options.get("merge"))
    if op_type == "rename":
        return bool(options.get("translate"))
    return bool(options.get("restructure"))  # add, move


class _SimTree:
    """In-memory copy of a run's map for checking (and previewing) AI
    operations. ``nodes``: id → {parent, hidden, text, key, seeded, teacher}
    (+ payload data when built for the preview)."""

    def __init__(self, nodes, order, created=()):
        self.nodes = nodes
        self.order = order  # ids in created order (siblings sort by it)
        self.next_new = 0
        # Terms this AI batch added itself: not "fixed" for its later ops.
        self.created = set(created)

    @classmethod
    def load(cls, run, question, created=()):
        rows = MindmapNode.objects.filter(run=run, question=question).order_by(
            "created_at", "pk"
        ).values_list("id", "parent_id", "hidden", "text", "text_key", "seeded", "teacher")
        nodes, order = {}, []
        for node_id, parent, hidden, text, key, seeded, teacher in rows:
            nodes[node_id] = {
                "parent": parent, "hidden": hidden, "text": text, "key": key,
                "seeded": seeded, "teacher": teacher,
            }
            order.append(node_id)
        return cls(nodes, order, created)

    @classmethod
    def for_preview(cls, run, question):
        """With the presenter payload per node and the contributing token ids
        (counts after a merge = distinct participants; never exposed).

        Read under the run lock (participants' add/withdraw take it too, so
        the reads agree; held only for these reads, never during the LLM
        call) — and tolerant anyway: only nodes present in both the node
        rows and the presenter tree are kept, with their whole path."""
        with transaction.atomic():
            _lock_run(run)
            sim = cls.load(run, question)
            payload = build_tree(run, question, presenter=True)
            contributions = list(
                MindmapContribution.objects.filter(
                    node__run=run, node__question=question
                ).values_list("node_id", "token_id")
            )

        def walk(entries):
            kept = []
            for entry in entries:
                children = entry.pop("children")
                if entry["id"] not in sim.nodes:
                    continue  # appeared between the reads: left out
                sim.nodes[entry["id"]]["payload"] = entry
                kept.append(entry)
                walk(children)
            return kept

        payload["nodes"] = walk(payload["nodes"])
        changed = True
        while changed:  # drop rows without payload, then orphans below them
            changed = False
            for node_id in list(sim.order):
                node = sim.nodes[node_id]
                if "payload" not in node or (
                    node["parent"] is not None and node["parent"] not in sim.nodes
                ):
                    del sim.nodes[node_id]
                    sim.order.remove(node_id)
                    changed = True
        for node in sim.nodes.values():
            node["tokens"] = set()
        for node_id, token_id in contributions:
            if node_id in sim.nodes:
                sim.nodes[node_id]["tokens"].add(token_id)
        sim.payload = payload
        return sim

    # Views the shared rule helpers read.
    @property
    def tree(self):
        return {nid: (n["parent"], n["hidden"]) for nid, n in self.nodes.items()}

    def children_of(self, node_id):
        return [
            (n["key"], nid, n["hidden"])
            for nid in self.order
            if (n := self.nodes[nid])["parent"] == node_id
        ]

    def clash(self, parent_id, key, exclude=None):
        for nid in self.order:
            n = self.nodes[nid]
            if n["parent"] == parent_id and n["key"] == key and nid != exclude:
                return nid
        return None

    def fixed(self, node_id):
        if node_id in self.created:
            return False
        n = self.nodes[node_id]
        return n["seeded"] or n["teacher"]

    def label(self, node_id):
        return None if node_id is None else self.nodes[node_id]["text"]

    # Mutations mirroring the primitives (preview only).
    def _payload(self, node_id):
        return self.nodes[node_id].get("payload")

    def merge(self, source_id, target_id):
        source, target = self.nodes[source_id], self.nodes[target_id]
        for key, child, _hidden in self.children_of(source_id):
            twin = self.clash(target_id, key)
            if twin is not None:
                self.merge(child, twin)
            else:
                self.nodes[child]["parent"] = target_id
        target["seeded"] = target["seeded"] or source["seeded"]
        target["teacher"] = target["teacher"] or source["teacher"]
        src_p, tgt_p = self._payload(source_id), self._payload(target_id)
        if tgt_p is not None:
            target["tokens"] |= source["tokens"]
            tgt_p["count"] = len(target["tokens"])
            seen = {d.casefold() for d in tgt_p["descriptions"]}
            for desc in src_p["descriptions"]:
                if desc.casefold() not in seen and len(tgt_p["descriptions"]) < MINDMAP_MAX_DESCRIPTIONS:
                    seen.add(desc.casefold())
                    tgt_p["descriptions"].append(desc)
            if target["teacher"]:
                tgt_p["teacher"] = True
            tgt_p["merged_from"] = [
                *tgt_p.get("merged_from", []),
                src_p["text"],
                *src_p.get("merged_from", []),
            ]
        del self.nodes[source_id]
        self.order.remove(source_id)

    def rename(self, node_id, text, key):
        node = self.nodes[node_id]
        payload = self._payload(node_id)
        if payload is not None:
            payload.setdefault("renamed_from", node["text"])
            payload["text"] = text
            payload["key"] = key
        node["text"], node["key"] = text, key

    def move(self, node_id, parent_id):
        self.nodes[node_id]["parent"] = parent_id
        payload = self._payload(node_id)
        if payload is not None and not payload.get("new"):
            payload["moved"] = True

    def add(self, parent_id, text, key):
        self.next_new -= 1
        node_id = self.next_new
        self.nodes[node_id] = {
            "parent": parent_id, "hidden": False, "text": text, "key": key,
            "seeded": False, "teacher": True, "tokens": set(),
            "payload": {
                "id": node_id, "text": text, "count": 0, "descriptions": [],
                "seeded": False, "teacher": True, "key": key, "hidden": False,
                "new": True,
            },
        }
        self.order.append(node_id)
        self.created.add(node_id)
        return node_id

    def preview(self):
        def walk(parent_id):
            result = []
            for nid in self.order:
                node = self.nodes[nid]
                if node["parent"] == parent_id:
                    result.append({**node["payload"], "children": walk(nid)})
            return result

        nodes = walk(None)
        return {**self.payload, "total": len(self.nodes), "nodes": nodes}


def _resolve(value, refs):
    """A node reference of an AI op: an int id, a temp ref of an earlier
    ``add`` (str), or None (main branch). Raises for an unresolved ref."""
    if isinstance(value, str):
        if value not in refs:
            raise MindmapError("Unknown term.", 404)
        return refs[value]
    return value


def _check_ai_op(sim, question, op, refs):
    """Validate one AI op against ``sim`` (shared rules + AI-only rules) and
    return it resolved (temp refs → ids, ``text``/``key`` cleaned) plus the
    names for its label. Raises MindmapError when it does not fit."""
    tree = sim.tree
    kind = op["type"]
    if kind == "merge":
        source, target = _resolve(op["source"], refs), _resolve(op["target"], refs)
        _check_merge(tree, question, source, target, sim.children_of)
        if sim.fixed(source):
            raise MindmapError("Presenter and predefined terms keep their names.", 409)
        return {"source": source, "target": target}
    if kind == "rename":
        node = _resolve(op["node"], refs)
        _node_or_404(tree, node)
        if _effectively_hidden(tree, node):
            raise MindmapError("This branch is hidden.", 409)
        if sim.fixed(node):
            raise MindmapError("Presenter and predefined terms keep their names.", 409)
        text = _clean_term(op["text"])
        key = text_key(text)
        if text == sim.nodes[node]["text"]:
            raise MindmapError("Nothing to change.")
        clash = sim.clash(sim.nodes[node]["parent"], key, exclude=node)
        if clash is not None:
            # Like a manual rename: the name exists there → merge into it.
            _check_merge(tree, question, node, clash, sim.children_of)
        return {"node": node, "text": text, "key": key, "clash": clash}
    if kind == "move":
        node = _resolve(op["node"], refs)
        parent = _resolve(op["parent"], refs)
        _node_or_404(tree, node)
        if _effectively_hidden(tree, node):
            raise MindmapError("This branch is hidden.", 409)
        if sim.fixed(node):
            raise MindmapError("Presenter and predefined terms stay where they are.", 409)
        old_parent = _check_move(tree, question, node, parent)
        if parent == old_parent:
            raise MindmapError("Nothing to change.")
        if sim.clash(parent, sim.nodes[node]["key"], exclude=node) is not None:
            raise MindmapError("A term with this name already exists there — merge instead.", 409)
        return {"node": node, "parent": parent, "old_parent": old_parent}
    # add
    parent = _resolve(op["parent"], refs)
    _check_add(tree, question, parent)
    text = _clean_term(op["text"])
    key = text_key(text)
    existing = sim.clash(parent, key)
    if existing is not None:
        if sim.nodes[existing]["hidden"]:
            raise MindmapError("This term already exists there but is hidden.", 409)
        return {"parent": parent, "text": text, "key": key, "existing": existing}
    if len(sim.nodes) >= MINDMAP_MAX_NODES:
        raise MindmapError("The mind map is full.", 409)
    return {"parent": parent, "text": text, "key": key, "existing": None}


REF_FIELDS = ("source", "target", "node", "parent")


def _describe(sim, op, resolved, ref_index):
    """Client entry for a valid op: index, type, the op's own references
    (node id, or the temp ref of an earlier ``add``), names, reason, label,
    ``requires`` (indices of ALL ``add`` ops it builds on, transitively)."""

    def name(node_id):
        return None if node_id is None else sim.label(node_id)

    kind = op["type"]
    entry = {"index": op["index"], "type": kind, "reason": op.get("reason", "")}
    if kind == "merge":
        source, target = name(resolved["source"]), name(resolved["target"])
        entry.update(source=op["source"], target=op["target"],
                     source_text=source, target_text=target,
                     label=f"{source} → {target}")
    elif kind == "rename":
        old = name(resolved["node"])
        entry.update(node=op["node"], text=resolved["text"], old_text=old,
                     merges_into=resolved["clash"],
                     label=f"{old} → {resolved['text']}")
    elif kind == "move":
        node, parent = name(resolved["node"]), name(resolved["parent"])
        entry.update(node=op["node"], parent=op["parent"], node_text=node,
                     parent_text=parent, old_parent_text=name(resolved["old_parent"]),
                     label=f"{node} → {parent if parent is not None else '⌂'}")
    else:
        entry.update(ref=op["ref"], parent=op["parent"], text=resolved["text"],
                     parent_text=name(resolved["parent"]), label=f"+ {resolved['text']}")
    requires = set()
    for field in REF_FIELDS:
        value = op.get(field)
        if isinstance(value, str) and value in ref_index:
            index, inherited = ref_index[value]
            requires |= {index, *inherited}
    entry["requires"] = sorted(requires)
    return entry


def _sim_apply(sim, op, resolved, refs):
    kind = op["type"]
    if kind == "merge":
        sim.merge(resolved["source"], resolved["target"])
    elif kind == "rename":
        if resolved["clash"] is not None:
            sim.merge(resolved["node"], resolved["clash"])
        else:
            sim.rename(resolved["node"], resolved["text"], resolved["key"])
    elif kind == "move":
        sim.move(resolved["node"], resolved["parent"])
    else:
        refs[op["ref"]] = sim.add(resolved["parent"], resolved["text"], resolved["key"])


def _run_ops(sim, question, ops, options, selected=None):
    """Walk ``ops`` in order on ``sim``: check each (``_check_ai_op``) and
    apply it in memory. ``selected`` (indices; None = all) limits what is
    applied — an unselected ``add`` leaves its temp ref unresolved, so the
    ops below it drop. An ``add`` of a term that already exists (visible)
    there changes nothing; its ref just points to that term.

    Returns ``(entries, failed, applied)``: client entries of the applied
    ops, the number of selected ops that did not fit, applied indices."""
    refs, ref_index = {}, {}
    entries, failed, applied = [], 0, []
    sim.aliased = set()  # adds of a term that exists there (no change)
    for op in ops:
        chosen = selected is None or op["index"] in selected
        if not chosen and op["type"] != "add":
            continue
        try:
            if not _op_enabled(op["type"], options):
                raise MindmapError("Switched off.")
            resolved = _check_ai_op(sim, question, op, refs)
        except MindmapError:
            failed += chosen
            continue
        if op["type"] == "add" and resolved["existing"] is not None:
            refs[op["ref"]] = resolved["existing"]
            sim.aliased.add(op["index"])
            continue
        if not chosen:
            continue
        entry = _describe(sim, op, resolved, ref_index)
        entries.append(entry)
        if op["type"] == "add":
            ref_index[op["ref"]] = (op["index"], entry["requires"])
        _sim_apply(sim, op, resolved, refs)
        applied.append(op["index"])
    return entries, failed, applied


def simulate_ops(run, question, ops, options, selected=None):
    """Check ``ops`` (``ai_mindmap.parse_ops`` output) in order against an
    in-memory copy of the map and preview the result.

    Returns ``{ops, dropped, preview, active}``: ``ops`` = the ops that fit
    when all are applied (``{index, type, …, label, reason, requires}``);
    ``dropped`` = how many fell out; ``preview`` = ``build_tree(presenter=
    True)`` after applying the ``selected`` indices (None = all), changed
    nodes marked with ``merged_from`` [texts], ``renamed_from``, ``moved``
    or ``new`` (negative id); ``active`` = the indices in that preview (a
    selected op can drop when an op it depends on is deselected)."""
    sim = _SimTree.for_preview(run, question)
    entries, dropped, applied = _run_ops(sim, question, ops, options)
    if selected is not None and set(selected) != set(applied):
        sim = _SimTree.for_preview(run, question)
        _entries, _failed, applied = _run_ops(
            sim, question, ops, options, set(selected) & set(applied)
        )
    return {"ops": entries, "dropped": dropped, "preview": sim.preview(), "active": applied}


def apply_ops(run, question, ops, options, selected, *, log=False):
    """Apply the ``selected`` ops (indices) in order, each re-checked against
    the live map (``_check_ai_op`` on a fresh copy) and run through the
    manual primitives. Like ``simulate_ops``, only ops that fit when the
    whole proposal is applied to the current map can be selected (preview
    and apply agree). Returns ``{applied, skipped, undo}``: ``skipped`` =
    selected ops that do not fit (any more); ``undo`` = ``[{type, data}]``
    in application order — merge/rename: the signed undo string; move:
    ``{node, parent}`` (old parent); add: ``{node}`` (inverse =
    ``teacher_delete``). All under one transaction and the run lock; 409
    (nothing applied) during the rating stage. With ``log``, the batch is
    one moderation-log entry (``log_id``, None when nothing was applied)."""
    applied, skipped, undo = 0, 0, []
    ensure_seed(run, question)
    with transaction.atomic():
        _lock_run(run)
        _refuse_while_rating(run, question)
        full = _SimTree.load(run, question)
        _entries, _failed, fitting = _run_ops(full, question, ops, options)
        # An add whose term exists by now is neither applied nor skipped.
        skipped = len(set(selected) - set(fitting) - full.aliased)
        selected = set(selected) & set(fitting)
        refs, created = {}, set()
        for op in ops:
            chosen = op["index"] in selected
            if not chosen and op["type"] != "add":
                continue
            try:
                if not _op_enabled(op["type"], options):
                    raise MindmapError("Switched off.")
                sim = _SimTree.load(run, question, created)
                resolved = _check_ai_op(sim, question, op, refs)
            except MindmapError:
                skipped += chosen
                continue
            if op["type"] == "add" and resolved["existing"] is not None:
                refs[op["ref"]] = resolved["existing"]
                continue
            if not chosen:
                continue
            try:
                with transaction.atomic():
                    item = _apply_one(run, question, op, resolved, refs)
            except (MindmapError, IntegrityError):
                skipped += 1
                continue
            if item is None:
                continue  # the term was already there: its ref points to it
            if item["type"] == "add":
                created.add(item["data"]["node"])
            undo.append(item)
            applied += 1
        result = {"applied": applied, "skipped": skipped, "undo": undo}
        if log:
            result["log_id"] = (
                _log(run, question, "ai", {"count": applied}, undo) if undo else None
            )
    return result


def _apply_one(run, question, op, resolved, refs):
    """Run one checked op through its manual primitive; the undo item, or
    None for an ``add`` whose term exists already (nothing to undo)."""
    kind = op["type"]
    if kind == "merge":
        blob = merge_nodes(run, question, resolved["source"], resolved["target"])
        return {"type": "merge", "data": blob}
    if kind == "rename":
        _node_id, merged, blob = rename_node(run, question, resolved["node"], resolved["text"])
        return {"type": "merge" if merged else "rename", "data": blob}
    if kind == "move":
        data = move_node(run, question, resolved["node"], resolved["parent"])
        return {"type": "move", "data": data}
    node, merged = teacher_add(run, question, resolved["parent"], resolved["text"])
    refs[op["ref"]] = node.pk
    return None if merged else {"type": "add", "data": {"node": node.pk}}


def sign_proposal(run, question, ops, options, malformed=0):
    """Signed (not encrypted) proposal for ai-preview/ai-apply: the parsed
    ops, the options they were made for and how many reply entries were
    malformed — bound to run + question, valid for UNDO_MAX_AGE."""
    return signing.dumps(
        {"run": run.pk, "question": question.pk, "ops": ops, "options": options,
         "malformed": malformed},
        salt=PROPOSAL_SALT, compress=True,
    )


def unsign_proposal(run, question, blob):
    """``(ops, options, malformed)`` of a signed proposal; MindmapError
    otherwise."""
    if not isinstance(blob, str):
        raise MindmapError("Invalid proposal.")
    try:
        data = signing.loads(blob, salt=PROPOSAL_SALT, max_age=UNDO_MAX_AGE)
    except signing.SignatureExpired as error:
        raise MindmapError("This proposal has expired.", 409) from error
    except signing.BadSignature as error:
        raise MindmapError("Invalid proposal.") from error
    if data.get("run") != run.pk or data.get("question") != question.pk:
        raise MindmapError("Invalid proposal.")
    return data["ops"], data["options"], data.get("malformed", 0)


def _undo_item(item):
    """Validate one undo item of ``apply_ops``; MindmapError (400) else."""
    if not isinstance(item, dict) or item.get("type") not in AI_OP_TYPES:
        raise MindmapError("Invalid undo data.")
    data = item.get("data")
    kind = item["type"]
    if kind in ("merge", "rename"):
        if not isinstance(data, str):
            raise MindmapError("Invalid undo data.")
        return kind, data

    def is_id(value):
        return isinstance(value, int) and not isinstance(value, bool)

    if not isinstance(data, dict) or not is_id(data.get("node")):
        raise MindmapError("Invalid undo data.")
    if kind == "move" and not (
        "parent" in data and (data["parent"] is None or is_id(data["parent"]))
    ):
        raise MindmapError("Invalid undo data.")
    return kind, data


def undo_ops(run, question, items, *, max_age=UNDO_MAX_AGE):
    """Reverse an ``apply_ops`` batch (its ``undo`` list) in reverse order —
    all or nothing: 409 + rollback when the map changed in a way that makes
    exact restoration impossible (like ``restore``)."""
    if not isinstance(items, list) or not items or len(items) > AI_OPS_MAX:
        raise MindmapError("Invalid undo data.")
    steps = [_undo_item(item) for item in items]
    signed = {
        index: _unsign(run, question, data, max_age)
        for index, (kind, data) in enumerate(steps)
        if kind in ("merge", "rename")
    }
    try:
        with transaction.atomic():
            _lock_run(run)
            _refuse_while_rating(run, question)
            for index in reversed(range(len(steps))):
                kind, data = steps[index]
                try:
                    if kind in ("merge", "rename"):
                        blob = signed[index]
                        if blob["op"] == "merge":
                            _restore_merge(run, question, blob["merge"])
                        else:
                            _restore_rename(run, question, blob)
                    elif kind == "move":
                        node = MindmapNode.objects.filter(
                            pk=data["node"], run=run, question=question
                        ).first()
                        if node is None:
                            raise MindmapError(_CHANGED, 409)
                        move_node(run, question, data["node"], data["parent"])
                    else:
                        teacher_delete(run, question, data["node"])
                except MindmapError as error:
                    raise MindmapError(_CHANGED, 409) from error
            _check_restored_tree(_load_tree(run, question), question.mindmap_depth)
            _mark_reset(run, question, ("ai",), items)
    except IntegrityError as error:
        raise MindmapError(_CHANGED, 409) from error
