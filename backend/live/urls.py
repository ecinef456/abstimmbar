# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

from django.urls import path

from . import views

# API routes (mounted under /api/ in config.urls).
api_urlpatterns = [
    path("live/rooms/<str:code>/join/", views.join),
    path("live/rooms/<str:code>/vote/", views.vote),
    path("live/rooms/<str:code>/retract/", views.retract),
    path("live/rooms/<str:code>/quiz/", views.quiz),
    path("live/rooms/<str:code>/my-evaluation/", views.my_evaluation),
    path("live/rooms/<str:code>/my-answer/", views.my_answer),
    path("live/rooms/<str:code>/stream/", views.stream),
    # Mind map (stage 1): shared tree, token-scoped.
    path("live/rooms/<str:code>/mindmap/add/", views.mindmap_add),
    path("live/rooms/<str:code>/mindmap/remove/", views.mindmap_remove),
    path("live/rooms/<str:code>/mindmap/mine/", views.mindmap_mine),
    # Four-field matrix: participant cards, token-scoped.
    path("live/rooms/<str:code>/matrix/add/", views.matrix_add),
    path("live/rooms/<str:code>/matrix/remove/", views.matrix_remove),
    path("live/rooms/<str:code>/matrix/mine/", views.matrix_mine),
    path("live/rooms/<str:code>/matrix/rate/", views.matrix_rate),
    path("live/rooms/<str:code>/matrix/my-ratings/", views.matrix_my_ratings),
    # Mind map rating phase: token-scoped.
    path("live/rooms/<str:code>/mindmap/rate/", views.mindmap_rate),
    path("live/rooms/<str:code>/mindmap/my-ratings/", views.mindmap_my_ratings),
    # Recording mode (#53): async viewer voting, keyed by the run's token.
    path("live/recording/<str:token>/", views.recording_questions),
    path("live/recording/<str:token>/vote/", views.recording_vote),
    # Self-check / Lernkontrolle (#75 Phase 3): permanent async link.
    path("live/check/<str:token>/", views.check_questions),
    path("live/check/<str:token>/attempt/", views.check_attempt),
    path("live/check/<str:token>/grade/", views.check_grade),
    path("question-sets/<int:set_id>/live-status/", views.live_status),
    path("question-sets/<int:set_id>/start-run/", views.start_run),
    path("question-sets/<int:set_id>/results/", views.set_results),
    path("question-sets/<int:set_id>/results.csv", views.results_csv),
    path("question-sets/<int:set_id>/delete-results/", views.delete_results),
    path("question-sets/<int:set_id>/archive-results/", views.archive_results),
    path("runs/<int:run_id>/control/", views.control_run),
    path("runs/<int:run_id>/ai-summary/", views.run_summary),
    path("runs/<int:run_id>/wordcloud-ai/", views.wordcloud_ai),
    path(
        "runs/<int:run_id>/wordcloud/<int:question_id>/moderation",
        views.wordcloud_moderation,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/move",
        views.matrix_move,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/stack",
        views.matrix_stack,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/unstack",
        views.matrix_unstack,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/stage",
        views.matrix_stage,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/hide",
        views.matrix_hide,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/add",
        views.matrix_teacher_add,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/delete",
        views.matrix_teacher_delete,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/ai-propose",
        views.matrix_ai_propose,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/ai-apply",
        views.matrix_ai_apply,
    ),
    path(
        "runs/<int:run_id>/matrix/<int:question_id>/ai-undo",
        views.matrix_ai_undo,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/hide",
        views.mindmap_hide,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/stage",
        views.mindmap_stage,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/add",
        views.mindmap_teacher_add,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/delete",
        views.mindmap_teacher_delete,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/merge",
        views.mindmap_merge,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/unmerge",
        views.mindmap_unmerge,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/move",
        views.mindmap_move,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/rename",
        views.mindmap_rename,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/ai-optimize",
        views.mindmap_ai_optimize,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/ai-preview",
        views.mindmap_ai_preview,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/ai-apply",
        views.mindmap_ai_apply,
    ),
    path(
        "runs/<int:run_id>/mindmap/<int:question_id>/ai-undo",
        views.mindmap_ai_undo,
    ),
    path(
        "runs/<int:run_id>/wordcloud/<int:question_id>/ai-settings",
        views.wordcloud_ai_settings,
    ),
    path(
        "runs/<int:run_id>/questions/<int:question_id>/ai-wordcloud/",
        views.optimize_wordcloud,
    ),
    path(
        "runs/<int:run_id>/questions/<int:question_id>/ai-freetext/",
        views.evaluate_freetext,
    ),
    path(
        "runs/<int:run_id>/questions/<int:question_id>/ai-summary/",
        views.freetext_summary,
    ),
    path("runs/<int:run_id>/", views.delete_run),
]

# Participant-facing pages (mounted at the site root).
page_urlpatterns = [
    path("p/", views.participant_home, name="participant-home"),
    path("p/<str:code>/", views.participant_page, name="participant-page"),
    # Deliberately OUTSIDE "/p/" so basicbar_lti's frame-ancestors middleware
    # leaves its framing headers alone (#74; the view sets its own CSP).
    path(
        "question-preview/<int:question_id>/",
        views.question_preview,
        name="question-preview",
    ),
    path("p/<str:code>/qr.png", views.room_qr, name="room-qr"),
    # Recording mode (#53): the viewer page + per-question QR.
    path("r/<str:token>/", views.recording_page, name="recording-page"),
    path("r/<str:token>/qr.png", views.recording_qr, name="recording-qr"),
    # Self-check / Lernkontrolle (#75 Phase 3): the viewer page + per-question QR.
    path("c/<str:token>/", views.check_page, name="check-page"),
    path("c/<str:token>/qr.png", views.check_qr, name="check-qr"),
]
