# SPDX-License-Identifier: Apache-2.0
from django.urls import path

from . import views

# Mounted under /api/quizbar/ in config.urls.
urlpatterns = [
    path("runs/<int:run_id>/justification/", views.run_justification),
]
