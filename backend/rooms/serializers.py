# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Serializers for the authoring API.

Answer options are embedded in their question (one request per editor save);
nested writes use a replace-by-id strategy: options the client omits are
deleted, options with an ``id`` are updated, options without one are created.
Option order follows array order.
"""
from typing import ClassVar

from django.conf import settings
from django.db.models import Count, Max
from django.utils.html import strip_tags
from rest_framework import serializers

from common.i18n_fields import LANGS, TranslatedMapMixin
from common.serializers import TranslationSyncMixin

from . import matrix, mindmap, set_types
from .models import AnswerOption, Question, QuestionSet, Room, Section, UploadedImage
from .naming import generate_default_titles
from .sanitize import clean_html, clean_media_url
from .transfer import sync_after_question

CONTENT_DEFAULT_LANGUAGE = settings.MODELTRANSLATION_DEFAULT_LANGUAGE

# Kinds whose editor requires answer options (excludes likert's preset scale
# and the text kinds). Distinct from models.CHOICE_KINDS on purpose.
OPTION_TEXT_KINDS = ("single_choice", "multiple_choice", "priorities", "ordering")


def _user_name(user):
    """Display name for provenance fields (empty if the account is gone)."""
    if user is None:
        return ""
    return user.get_full_name() or user.username


def next_outline_position(question_set):
    """Sections and questions share one ordering sequence (the inline
    outline): the next slot is one past the highest position of either."""
    q = question_set.questions.aggregate(m=Max("position"))["m"]
    s = question_set.sections.aggregate(m=Max("position"))["m"]
    return max(q if q is not None else -1, s if s is not None else -1) + 1


class RoomSerializer(TranslatedMapMixin, serializers.ModelSerializer):
    # title/description/closing_info are authored in de+en (#33 MR2); each is
    # represented as a {"de": ..., "en": ...} map. A blank canonical (de)
    # title gets a readable timestamped default instead of a 400 — that
    # default/uniqueness logic lives in validate(), so title is exempted
    # from the mixin's own canonical-required check (translated_optional_fields).
    translated_fields = ("title", "description", "closing_info")
    translated_optional_fields = ("title",)

    question_set_count = serializers.IntegerField(read_only=True)
    set_type_counts = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()
    updated_by_name = serializers.SerializerMethodField()
    owner_name = serializers.SerializerMethodField()
    is_owner = serializers.SerializerMethodField()
    is_member = serializers.SerializerMethodField()
    owner_count = serializers.SerializerMethodField()
    is_favorite = serializers.SerializerMethodField()
    is_archived = serializers.SerializerMethodField()
    last_used_at = serializers.SerializerMethodField()
    is_lti = serializers.SerializerMethodField()

    class Meta:
        model = Room
        fields: ClassVar = [
            "id", "code", "title", "description", "show_logo_in_presentation",
            "show_qr_in_presentation", "show_code_in_presentation",
            "presentation_corner", "closing_info",
            "question_set_count", "set_type_counts", "created_at", "updated_at",
            "created_by_name", "updated_by_name",
            "owner_name", "is_owner", "is_member", "owner_count",
            "is_favorite", "is_archived",
            "last_used_at", "is_lti",
        ]
        read_only_fields: ClassVar = ["code"]

    def get_created_by_name(self, obj):
        return _user_name(obj.created_by)

    def get_owner_name(self, obj):
        return _user_name(obj.owner)

    def get_is_owner(self, obj):
        # The room's Besitzer, or a legacy/dev room without an owner (kept
        # actionable). Staff privilege no longer implies ownership — otherwise
        # every room looked "mine" and the shared/foreign split collapsed.
        request = self.context.get("request")
        if not request:
            return False
        return obj.owner_id is None or obj.owner_id == request.user.pk

    def get_is_member(self, obj):
        annotated = getattr(obj, "is_member", None)
        if annotated is not None:
            return bool(annotated)
        request = self.context.get("request")
        return bool(request and obj.owners.filter(pk=request.user.pk).exists())

    def get_owner_count(self, obj):
        annotated = getattr(obj, "owner_count", None)
        if annotated is not None:
            return annotated
        return obj.owners.count()

    def get_set_type_counts(self, obj):
        """Per-type set counts for the room-card breakdown (#75), keyed by set
        type value. Prefers the `set_count_<value>` annotations from the list
        queryset; falls back to a grouped count for a bare instance (e.g. the
        create response, which isn't annotated)."""
        types = [value for value, _ in QuestionSet.SetType.choices]
        if hasattr(obj, f"set_count_{types[0]}"):
            return {value: getattr(obj, f"set_count_{value}", 0) or 0 for value in types}
        counts = {value: 0 for value in types}
        for row in obj.question_sets.values("type").annotate(n=Count("id")):
            counts[row["type"]] = row["n"]
        return counts

    def get_updated_by_name(self, obj):
        return _user_name(obj.updated_by)

    def get_is_favorite(self, obj):
        annotated = getattr(obj, "is_favorite", None)
        if annotated is not None:
            return bool(annotated)
        request = self.context.get("request")
        return bool(request and obj.favorited_by.filter(pk=request.user.pk).exists())

    def get_is_archived(self, obj):
        annotated = getattr(obj, "is_archived", None)
        if annotated is not None:
            return bool(annotated)
        request = self.context.get("request")
        return bool(request and obj.archived_by.filter(pk=request.user.pk).exists())

    def get_last_used_at(self, obj):
        return getattr(obj, "last_used_at", None)

    def get_is_lti(self, obj):
        annotated = getattr(obj, "is_lti", None)
        if annotated is not None:
            return bool(annotated)
        return obj.lti_links.exists()

    def validate_description(self, value):
        return clean_html(value)

    def validate_closing_info(self, value):
        return clean_html(value)

    def validate(self, attrs):
        # After TranslatedMapMixin runs, the canonical (content-default-
        # language) value lives in attrs["title_<default>"], not the bare
        # "title" (which the mixin never sets) — see #33 MR2 CLAUDE.md note
        # on the UI-language/content-language divergence. Deliberately never
        # write the bare "title" key here: ModelSerializer.update() applies
        # validated_data in dict-insertion order via plain setattr(), and
        # setting the bare (active-language-descriptor-backed) "title" after
        # title_en/title_de would silently clobber whichever language column
        # matches the *request's* active language — discovered while writing
        # test_write_with_map_sets_both_columns/test_empty_second_language_
        # stores_none. The per-language columns are the sole source of truth.
        canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
        user = self.context["request"].user
        owned = Room.objects.filter(owners=user)
        title = (attrs.get(canonical_key, attrs.get("title")) or "").strip()
        if not title:
            if self.instance is None:
                generated = generate_default_titles(
                    {"de": "Unbenannter Raum", "en": "Unnamed room"},
                    CONTENT_DEFAULT_LANGUAGE,
                    lambda t: owned.filter(**{f"{canonical_key}__iexact": t}).exists(),
                )
                # Fill the canonical column, and any OTHER language only when
                # the user left it blank too — never clobber a translation
                # they did provide (e.g. de="" but en="Keep me").
                for lang, value in generated.items():
                    col = f"title_{lang}"
                    if lang == CONTENT_DEFAULT_LANGUAGE or not (attrs.get(col) or "").strip():
                        attrs[col] = value
            else:
                attrs.pop(canonical_key, None)
                attrs.pop("title", None)  # blank rename keeps the old title
            return attrs
        attrs[canonical_key] = title
        conflicts = owned.filter(**{f"{canonical_key}__iexact": title})
        if self.instance is not None:
            conflicts = conflicts.exclude(pk=self.instance.pk)
        if conflicts.exists():
            raise serializers.ValidationError(
                {"title": "Sie haben bereits einen Raum mit diesem Namen."}
            )
        return attrs


class QuestionSetSerializer(TranslatedMapMixin, serializers.ModelSerializer):
    # title/description are {"de","en"} maps like Room's (#33 MR2); title
    # keeps its own blank -> timestamped-default/uniqueness logic in
    # validate(), so it is exempt from the mixin's canonical-required check.
    translated_fields = ("title", "description")
    translated_optional_fields = ("title",)

    question_count = serializers.IntegerField(read_only=True)
    room_title = serializers.CharField(source="room.title", read_only=True)
    # Whether any run of this set has stored votes (table column, concept §5.1).
    has_results = serializers.SerializerMethodField()

    class Meta:
        model = QuestionSet
        fields: ClassVar = [
            "id", "room", "room_title", "title", "description", "type", "reveal_answers",
            "open_on_show", "show_results_to_participants", "present_results_after",
            "allow_back_navigation", "shuffle_questions", "reveal_only_in_summary",
            "quiz_time_limit",
            "share_token", "self_check_token", "license", "license_holder",
            "question_count", "has_results", "created_at", "updated_at",
        ]
        read_only_fields: ClassVar = ["share_token", "self_check_token"]

    def get_has_results(self, obj):
        annotated = getattr(obj, "has_answers", None)
        if annotated is not None:
            return bool(annotated)
        from live.mindmap import answered_runs_q

        return obj.runs.filter(answered_runs_q()).exists()

    def validate_room(self, room):
        user = self.context["request"].user
        if not (user.is_staff or room.owners.filter(pk=user.pk).exists()):
            raise serializers.ValidationError("You do not manage this room.")
        return room

    def validate_description(self, value):
        return clean_html(value)

    def validate_quiz_time_limit(self, value):
        if value is None:
            return value
        if value <= 0 or value > 24 * 3600:
            raise serializers.ValidationError("Must be between 1 and 86400 seconds.")
        return value

    def validate(self, attrs):
        # A time limit only applies to self-paced sets; null it here for
        # any other effective type, but only when the field is actually
        # being written so an unrelated PATCH can't wipe an existing value.
        if "quiz_time_limit" in attrs:
            effective_type = (
                self.instance.type if self.instance is not None
                else attrs.get("type", QuestionSet.SetType.LIVE_POLL)
            )
            if effective_type != QuestionSet.SetType.SELF_PACED:
                attrs["quiz_time_limit"] = None

        # See RoomSerializer.validate: canonical value is title_<default>;
        # the bare "title" key is deliberately never written (update-order
        # clobber risk documented there).
        canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
        room = attrs.get("room") or (self.instance.room if self.instance else None)
        title = (attrs.get(canonical_key, attrs.get("title")) or "").strip()
        if not title:
            if self.instance is None:
                generated = generate_default_titles(
                    {"de": "Unbenanntes Fragenset", "en": "Unnamed question set"},
                    CONTENT_DEFAULT_LANGUAGE,
                    lambda t: room.question_sets.filter(
                        **{f"{canonical_key}__iexact": t}
                    ).exists(),
                )
                # Fill the canonical column, and any OTHER language only when
                # the user left it blank too (never clobber a provided one).
                for lang, value in generated.items():
                    col = f"title_{lang}"
                    if lang == CONTENT_DEFAULT_LANGUAGE or not (attrs.get(col) or "").strip():
                        attrs[col] = value
            else:
                attrs.pop(canonical_key, None)
                attrs.pop("title", None)
            return attrs
        attrs[canonical_key] = title
        conflicts = room.question_sets.filter(**{f"{canonical_key}__iexact": title})
        if self.instance is not None:
            conflicts = conflicts.exclude(pk=self.instance.pk)
        if conflicts.exists():
            raise serializers.ValidationError(
                {"title": "In diesem Raum gibt es bereits ein Fragenset mit "
                          "diesem Namen."}
            )
        return attrs

    def update(self, instance, validated_data):
        validated_data.pop("type", None)  # set type is fixed after creation (#75)
        # A set stays in its room; moving between rooms is a copy (M3).
        validated_data.pop("room", None)
        return super().update(instance, validated_data)


class SectionSerializer(TranslatedMapMixin, serializers.ModelSerializer):
    """Named question group inside a set (v2). A blank title gets a
    numbered default; the room owner check runs via the set."""

    # title is a {"de","en"} map (#33 MR2); its own numbered-default logic
    # lives in create()/update(), so it is exempt from the mixin's
    # canonical-required check.
    translated_fields = ("title", "description")
    translated_optional_fields = ("title",)

    class Meta:
        model = Section
        fields: ClassVar = ["id", "question_set", "title", "description", "position"]
        read_only_fields: ClassVar = ["position"]

    def validate_question_set(self, question_set):
        user = self.context["request"].user
        if not (
            user.is_staff or question_set.room.owners.filter(pk=user.pk).exists()
        ):
            raise serializers.ValidationError("You do not manage this room.")
        return question_set

    def validate_description(self, value):
        return clean_html(value)

    def to_internal_value(self, data):
        attrs = super().to_internal_value(data)
        # The mixin treats a fully blank map on update as "keep the old
        # value" (right for titles); the optional description must be
        # clearable, so an explicitly sent blank map empties every language.
        if (
            self.instance is not None
            and isinstance(data, dict)
            and "description" in data
            and not any(
                attrs.get(f"description_{lang}") for lang in LANGS
            )
        ):
            for lang in LANGS:
                attrs[f"description_{lang}"] = ""
        return attrs

    def create(self, validated_data):
        # See RoomSerializer.validate: canonical value is title_<default>;
        # the bare "title" key is deliberately never written (update-order
        # clobber risk documented there).
        canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
        question_set = validated_data["question_set"]
        if not (validated_data.get(canonical_key, validated_data.get("title")) or "").strip():
            count = question_set.sections.count()
            validated_data[canonical_key] = f"Abschnitt {count + 1}"
        # New section joins the shared outline sequence at the end.
        validated_data["position"] = next_outline_position(question_set)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        # A section stays in its set; position changes go through reorder.
        canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
        validated_data.pop("question_set", None)
        validated_data.pop("position", None)
        if not (validated_data.get(canonical_key, validated_data.get("title")) or "").strip():
            # blank rename keeps old title
            validated_data.pop(canonical_key, None)
            validated_data.pop("title", None)
        return super().update(instance, validated_data)


class AnswerOptionSerializer(TranslatedMapMixin, serializers.ModelSerializer):
    # text is a {"de","en"} map (#33 MR2); no extra default/uniqueness logic.
    translated_fields = ("text",)

    # Explicit id lets the client reference existing options in nested updates.
    id = serializers.IntegerField(required=False)

    class Meta:
        model = AnswerOption
        fields: ClassVar = ["id", "text", "image", "is_correct", "is_abstention"]

    def validate_image(self, value):
        # Only our own media storage; foreign URLs are silently dropped.
        return clean_media_url(value)


class QuestionSerializer(TranslationSyncMixin, TranslatedMapMixin, serializers.ModelSerializer):
    # text is a {"de","en"} map (#33 MR2); validate_text (HTML sanitizing)
    # keeps running — the mixin invokes it per language.
    translated_fields = (
        "text", "mindmap_root",
        "matrix_x_from", "matrix_x_to", "matrix_y_from", "matrix_y_to",
    )

    # Stale-translation detection (#91): translation_stale (read) reports
    # which languages of `text` look out of date; synced_fields (write)
    # lets the client re-baseline it (e.g. after a translation or an
    # explicit "mark as up to date"). Both fields are injected by the mixin's
    # get_fields() (NOT listed in Meta.fields below — see TranslationSyncMixin
    # for why that would break ModelSerializer's field building).
    translation_sync_fields = ("text",)

    options = AnswerOptionSerializer(many=True, required=False)

    # Vorher-Nachher-Paar (#54): all read-only — the link is set only by the
    # add-after action, and an after-question's content is managed by its
    # before-question (sync).
    before_question = serializers.PrimaryKeyRelatedField(read_only=True)
    after_question = serializers.SerializerMethodField()
    is_after = serializers.SerializerMethodField()

    class Meta:
        model = Question
        fields: ClassVar = [
            "id", "question_set", "section", "kind", "text", "shuffle_options",
            "binary_choice",
            "time_limit", "position", "options", "ai_evaluate", "evaluation_hint",
            "allow_multiple", "wordcloud_live", "wordcloud_ai_enabled",
            "wordcloud_grouping", "wordcloud_grouping_use_solution",
            "wordcloud_merge_variants",
            "wordcloud_merge_synonyms", "wordcloud_merge_concepts",
            "wordcloud_max_answers", "wordcloud_batch_submit",
            "evaluation_categories", "evaluation_chart",
            "model_solution", "participant_feedback",
            "mindmap_root", "mindmap_depth", "mindmap_max_per_person",
            "mindmap_descriptions", "mindmap_highlight_duplicates", "mindmap_seed",
            "mindmap_rating_mode", "mindmap_rating_budget", "mindmap_rating_multi",
            "mindmap_rating_live", "mindmap_ai_merge", "mindmap_ai_translate",
            "mindmap_ai_target_lang", "mindmap_ai_restructure",
            "matrix_x_from", "matrix_x_to", "matrix_y_from", "matrix_y_to",
            "matrix_edges", "matrix_descriptions", "matrix_max_per_person",
            "matrix_category_mode", "matrix_categories",
            "reveal_answers", "before_question", "after_question", "is_after",
            "created_at", "updated_at",
        ]
        read_only_fields: ClassVar = ["position"]

    def get_after_question(self, obj):
        try:
            return obj.after_question.pk
        except Question.DoesNotExist:
            return None

    def get_is_after(self, obj):
        return obj.before_question_id is not None

    def validate_text(self, value):
        return clean_html(value)

    def validate_wordcloud_grouping(self, value):
        # Same cap as the presenter's ai-settings endpoint; an unchanged
        # (legacy, longer) stored value stays saveable.
        if len(value) > 1000 and not (
            self.instance is not None and value == self.instance.wordcloud_grouping
        ):
            raise serializers.ValidationError("Max. 1000 characters.")
        return value

    def validate_evaluation_categories(self, value):
        # 2–5 trimmed, unique, non-empty labels; else the default scale.
        from .models import default_verdicts

        cleaned, seen = [], set()
        for raw in value or []:
            label = str(raw).strip()[:40]
            key = label.casefold()
            if label and key not in seen:
                seen.add(key)
                cleaned.append(label)
        return cleaned if 2 <= len(cleaned) <= 5 else default_verdicts()

    def validate_question_set(self, question_set):
        user = self.context["request"].user
        if not (
            user.is_staff or question_set.room.owners.filter(pk=user.pk).exists()
        ):
            raise serializers.ValidationError("You do not manage this room.")
        return question_set

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        # Gate the question kind by the set's type (#75).
        target_set = attrs.get("question_set") or getattr(
            self.instance, "question_set", None
        )
        if target_set is not None and kind is not None:
            if kind not in set_types.allowed_kinds(target_set.type):
                raise serializers.ValidationError(
                    {"kind": "This question type is not allowed in this set."}
                )
            # #75 Phase 3: in a Lernkontrolle a free-text question always shows
            # the learner their own evaluation — the setting is not offered.
            if (
                target_set.type == QuestionSet.SetType.SELF_CHECK
                and kind == Question.Kind.OPEN_TEXT
            ):
                attrs["participant_feedback"] = True
        # #88: a word cloud's `allow_multiple` is derived from the per-person
        # cap — 1 = a single, final answer; 0/N = multiple. Batch submit only
        # applies to the multi-answer case, so force it off for a single answer.
        if kind == Question.Kind.WORD_CLOUD:
            _missing_max = object()
            submitted_max = attrs.get("wordcloud_max_answers", _missing_max)
            max_answers = (
                submitted_max
                if submitted_max is not _missing_max
                else getattr(self.instance, "wordcloud_max_answers", 5)
            )
            attrs["allow_multiple"] = max_answers != 1
            if max_answers == 1:
                attrs["wordcloud_batch_submit"] = False
        if kind in Question.OPTIONLESS_KINDS and attrs.get("options"):
            raise serializers.ValidationError(
                {"options": "Text questions have no answer options."}
            )
        # Mindmap rating phase: switching the mode (points ↔ plus/minus/off)
        # would reinterpret ratings already given in a running session.
        if (
            self.instance is not None
            and "mindmap_rating_mode" in attrs
            and attrs["mindmap_rating_mode"] != self.instance.mindmap_rating_mode
        ):
            from live.models import MindmapRating, Run

            if MindmapRating.objects.filter(node__question=self.instance).exclude(
                node__run__phase=Run.Phase.FINISHED
            ).exists():
                raise serializers.ValidationError({
                    "mindmap_rating_mode": (
                        "The rating mode cannot be changed while a running "
                        "session already has ratings."
                    )
                })
        # Mindmap: the predefined branches must fit the (possibly changed)
        # depth — re-checked whenever either is written.
        if kind == Question.Kind.MINDMAP and (
            "mindmap_seed" in attrs or "mindmap_depth" in attrs or self.instance is None
        ):
            depth = attrs.get(
                "mindmap_depth",
                getattr(self.instance, "mindmap_depth", mindmap.MINDMAP_DEFAULT_DEPTH),
            )
            seed = attrs.get("mindmap_seed", getattr(self.instance, "mindmap_seed", []))
            try:
                attrs["mindmap_seed"] = mindmap.clean_seed(seed, depth, strict=True)
            except mindmap.SeedError as exc:
                raise serializers.ValidationError({"mindmap_seed": str(exc)}) from exc
        # Matrix: all four axis labels are required (canonical language);
        # categories must fit the (possibly changed) mode.
        if kind == Question.Kind.MATRIX:
            canonical_lang = CONTENT_DEFAULT_LANGUAGE
            for base in matrix.AXIS_LABEL_FIELDS:
                col = f"{base}_{canonical_lang}"
                label = attrs[col] if col in attrs else (
                    getattr(self.instance, col, "") if self.instance else ""
                )
                if not (label or "").strip():
                    raise serializers.ValidationError(
                        {base: "This axis label is required."}
                    )
            if (
                self.instance is None
                or "matrix_category_mode" in attrs
                or "matrix_categories" in attrs
            ):
                mode = attrs.get(
                    "matrix_category_mode",
                    getattr(self.instance, "matrix_category_mode", matrix.MODE_OFF),
                )
                categories = attrs.get(
                    "matrix_categories",
                    getattr(self.instance, "matrix_categories", []),
                )
                try:
                    attrs["matrix_categories"] = matrix.clean_categories(
                        categories, mode
                    )
                except matrix.CategoryError as exc:
                    raise serializers.ValidationError(
                        {"matrix_categories": str(exc)}
                    ) from exc
        # A section must belong to the same set as the question.
        section = attrs.get("section")
        if section is not None:
            question_set = attrs.get("question_set") or (
                self.instance.question_set if self.instance else None
            )
            if question_set and section.question_set_id != question_set.pk:
                raise serializers.ValidationError(
                    {"section": "Section belongs to another set."}
                )
        # Content validation (#32/#23) runs on the editor Save (update) only, so
        # the "+ New question" scaffold (create) stays permissive. The canonical
        # (content-default-language) text lives in attrs["text_<default>"] when
        # written, but a blank map is a no-op that never lands there — so fall
        # back to the instance's stored value.
        if self.instance is not None:
            canonical = f"text_{CONTENT_DEFAULT_LANGUAGE}"
            # Distinguish "key absent" (a partial PATCH not touching text at
            # all -> fall back to the instance) from "key present with value
            # None" (client explicitly cleared the canonical language via a
            # partial map, e.g. {"de": "", "en": "..."} -> treat as empty).
            # attrs.get(canonical) alone can't tell these apart since both
            # read as None.
            _missing = object()
            resolved = attrs.get(canonical, _missing)
            if resolved is _missing:
                resolved = getattr(self.instance, canonical, "") or ""
            resolved = resolved or ""
            if not (strip_tags(resolved).strip() or "<img" in resolved.lower()):
                raise serializers.ValidationError(
                    {"text": "Question text is required."}
                )
            if kind in OPTION_TEXT_KINDS and "options" in attrs:
                options = attrs["options"]

                def _filled(option):
                    text = (option.get(canonical) or "").strip()
                    return bool(text) or bool(option.get("image"))

                if len(options) < 2 or not all(_filled(o) for o in options):
                    raise serializers.ValidationError(
                        {"options": "Add at least two answer options, each with text."}
                    )
        return attrs

    def create(self, validated_data):
        options = validated_data.pop("options", [])
        question_set = validated_data["question_set"]
        last = question_set.questions.order_by("-position").first()
        # New questions append at the end of the shared outline sequence and,
        # unless told otherwise, join the last question's section — so adding
        # to a set that ends in a section keeps them in that section.
        validated_data["position"] = next_outline_position(question_set)
        if "section" not in validated_data and last is not None:
            validated_data["section"] = last.section
        question = super().create(validated_data)
        self._write_options(question, options)
        return question

    def update(self, instance, validated_data):
        # A question stays in its set; moving between sets is a v2 feature.
        validated_data.pop("question_set", None)
        options = validated_data.pop("options", None)
        question = super().update(instance, validated_data)
        if options is not None:
            self._write_options(question, options)
        # Keep a linked after-question's content in sync (#54); no-op otherwise.
        sync_after_question(question)
        return question

    def _write_options(self, question, options_data):
        keep = []
        existing = {option.pk: option for option in question.options.all()}
        for index, data in enumerate(options_data):
            option_id = data.pop("id", None)
            data["position"] = index
            if option_id and option_id in existing:
                option = existing[option_id]
                for field, value in data.items():
                    setattr(option, field, value)
                option.save()
            else:
                option = AnswerOption.objects.create(question=question, **data)
            keep.append(option.pk)
        question.options.exclude(pk__in=keep).delete()


class UploadedImageSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = UploadedImage
        fields: ClassVar = ["id", "file", "url"]
        extra_kwargs: ClassVar = {"file": {"write_only": True}}

    def get_url(self, obj):
        return obj.file.url
