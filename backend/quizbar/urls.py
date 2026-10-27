# SPDX-License-Identifier: Apache-2.0
from django.urls import path

from . import views

# Mounted under /api/quizbar/ in config.urls.
urlpatterns = [
    path("runs/<int:run_id>/justification/", views.run_justification),
    path("rooms/<int:room_id>/folders/", views.room_folders),
    path("folders/<int:folder_id>/", views.folder_detail),
    path("folders/<int:folder_id>/order/", views.folder_order),
    path("sets/<int:set_id>/folder/", views.set_folder),
    path("sets/<int:set_id>/next/", views.set_next),
    path("sets/<int:set_id>/self-check-sources/", views.self_check_sources),
    path("rooms/<int:room_id>/duplicate/", views.duplicate_room),
    path("library/", views.library_list),
    path("library/entries/<int:entry_id>/", views.library_entry),
    path("library/tags/", views.library_bulk_tags),
    path("library/tags/<int:tag_id>/", views.library_tag),
    path("library/insert/", views.library_insert),
    path("library/import/", views.import_library),
    path("rooms/<int:room_id>/import-typst/", views.import_typst),
    path("export/", views.export_pdf),
    path("translate/", views.translate_question),
    path("rooms/<int:room_id>/stats/", views.room_stats),
    path("rooms/<int:room_id>/stats/csv/", views.room_stats_csv),
    path("rooms/<int:room_id>/stats/pdf/", views.room_stats_pdf),
    path("sets/<int:set_id>/stats/", views.set_stats),
    path("runs/<int:run_id>/peer/", views.peer_start),
    path("sets/<int:set_id>/confidence/", views.set_confidence),
    path("confidence/<str:code>/", views.confidence),
    path("sets/<int:set_id>/game/", views.set_game),
    path("game/<str:code>/me/", views.game_me),
    path("game/<str:code>/enter/", views.game_enter),
    path("game/runs/<int:run_id>/leaderboard/", views.game_leaderboard),
]
