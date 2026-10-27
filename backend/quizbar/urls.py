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
]
