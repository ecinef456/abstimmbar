# SPDX-License-Identifier: Apache-2.0
from django.contrib import admin

from .models import OptionJustification


@admin.register(OptionJustification)
class OptionJustificationAdmin(admin.ModelAdmin):
    list_display = ("option", "text")
    raw_id_fields = ("option",)
