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

    def ready(self):
        from django.db.models.signals import post_save, pre_delete

        from rooms.models import Question

        from . import library

        def created(sender, instance, created, raw=False, **kwargs):
            if created and not raw:
                library.on_created(instance)

        def deleting(sender, instance, origin=None, **kwargs):
            library.rescue(instance, origin=origin)

        post_save.connect(created, sender=Question, dispatch_uid="quizbar_library_created")
        pre_delete.connect(deleting, sender=Question, dispatch_uid="quizbar_library_rescue")
