# SPDX-License-Identifier: Apache-2.0
"""Tags get one spelling: lower case, spaces become "-". Tags that end up
with the same name are merged."""
import re

from django.db import migrations


def normalize(raw):
    name = re.sub(r"[\s,]+", "-", str(raw).strip().lower())
    return re.sub(r"-{2,}", "-", name).strip("-")[:60].strip("-")


def forwards(apps, schema_editor):
    LibraryTag = apps.get_model("quizbar", "LibraryTag")
    groups = {}
    for tag in LibraryTag.objects.order_by("owner_id", "id"):
        groups.setdefault((tag.owner_id, normalize(tag.name) or "tag"), []).append(tag)
    renames = []
    for (_, name), tags in groups.items():
        # Keep a tag already spelled right (no clash on rename), else the oldest.
        keeper = next((t for t in tags if t.name == name), tags[0])
        for tag in tags:
            if tag is keeper:
                continue
            for entry in tag.entries.all():
                entry.tags.add(keeper)
            tag.delete()
        if keeper.name != name:
            renames.append((keeper, name))
    for keeper, name in renames:
        keeper.name = name
        keeper.save(update_fields=["name"])


class Migration(migrations.Migration):
    dependencies = [("quizbar", "0005_library")]
    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
