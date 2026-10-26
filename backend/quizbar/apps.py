# SPDX-License-Identifier: Apache-2.0
"""quizbar: this fork's own features, kept apart from the upstream apps.

Everything here lives in its own tables (linked to upstream models by
foreign keys) so upstream migrations and ours never collide when merging
virtUOS/abstimmbar into this fork.
"""
from django.apps import AppConfig


class QuizbarConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "quizbar"
    verbose_name = "quizbar (fork features)"
