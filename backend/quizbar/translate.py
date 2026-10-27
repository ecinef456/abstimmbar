# SPDX-License-Identifier: Apache-2.0
"""Automatic translation of a question (text, answers, justifications)
between English, German and French — a draft the teacher checks.

Provider (environment of the app container):
- DeepL: ``QUIZBAR_DEEPL_KEY`` (a free key ends in ":fx" and uses
  api-free.deepl.com);
- LibreTranslate: ``QUIZBAR_LIBRETRANSLATE_URL`` (e.g. a container on the
  same machine), optional ``QUIZBAR_LIBRETRANSLATE_KEY``.
DeepL wins when both are set. Independent of upstream's own (de/en)
translation switch.

Math (``$…$``, ``\\(…\\)``, ``$$…$$``) never goes to the translator: it is
replaced by numbered ``<span translate="no">`` markers and put back after.
Everything is sent as HTML (plain answers are escaped first) so markup
survives.
"""
import html
import json
import os
import re
from urllib import error, request

LANGS = ("en", "de", "fr")
DEEPL_TARGET = {"en": "EN-GB", "de": "DE", "fr": "FR"}
MATH = re.compile(r"\$\$.+?\$\$|\\\(.+?\\\)|\\\[.+?\\\]|(?<!\\)\$[^$]+?(?<!\\)\$", re.DOTALL)
MARK = re.compile(r'<span[^>]*data-qbm="(\d+)"[^>]*>.*?</span>', re.DOTALL)
TIMEOUT = 30


class TranslateError(Exception):
    pass


def provider():
    if os.environ.get("QUIZBAR_DEEPL_KEY"):
        return "deepl"
    if os.environ.get("QUIZBAR_LIBRETRANSLATE_URL"):
        return "libretranslate"
    return ""


def _protect(text, store):
    def keep(match):
        store.append(match.group(0))
        return f'<span translate="no" class="notranslate" data-qbm="{len(store) - 1}">§{len(store) - 1}</span>'

    return MATH.sub(keep, text)


def _restore(text, store):
    text = MARK.sub(lambda m: store[int(m.group(1))] if int(m.group(1)) < len(store) else m.group(0), text)
    # a translator that dropped the span but kept "§n"
    return re.sub(r"§(\d+)", lambda m: store[int(m.group(1))] if int(m.group(1)) < len(store) else m.group(0), text)


def _post(url, payload, headers):
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise TranslateError(f"Translation service: HTTP {exc.code} {detail}".strip()) from exc
    except (error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise TranslateError(f"Translation service unavailable: {exc}") from exc


def _deepl(texts, source, target):
    key = os.environ["QUIZBAR_DEEPL_KEY"]
    host = "api-free.deepl.com" if key.endswith(":fx") else "api.deepl.com"
    payload = {"text": texts, "target_lang": DEEPL_TARGET[target], "tag_handling": "html"}
    if source:
        payload["source_lang"] = source.upper()
    data = _post(f"https://{host}/v2/translate", payload, {"Authorization": f"DeepL-Auth-Key {key}"})
    return [item.get("text", "") for item in data.get("translations", [])]


def _libretranslate(texts, source, target):
    url = os.environ["QUIZBAR_LIBRETRANSLATE_URL"].rstrip("/") + "/translate"
    payload = {"q": texts, "source": source or "auto", "target": target, "format": "html"}
    if os.environ.get("QUIZBAR_LIBRETRANSLATE_KEY"):
        payload["api_key"] = os.environ["QUIZBAR_LIBRETRANSLATE_KEY"]
    data = _post(url, payload, {})
    out = data.get("translatedText") if isinstance(data, dict) else None
    if isinstance(out, str):
        out = [out]
    if not isinstance(out, list):
        raise TranslateError("Translation service returned no text.")
    return out


def translate_many(texts, source, target):
    """Translate a list of HTML strings (empty ones stay empty)."""
    which = provider()
    if not which:
        raise TranslateError("No translation service is set up.")
    if target not in LANGS or (source and source not in LANGS):
        raise TranslateError("Unknown language.")
    stores, payload, slots = [], [], []
    for index, text in enumerate(texts):
        if not (text or "").strip():
            continue
        store = []
        payload.append(_protect(text, store))
        stores.append(store)
        slots.append(index)
    out = list(texts)
    if not payload:
        return out
    call = _deepl if which == "deepl" else _libretranslate
    translated = call(payload, source, target)
    if len(translated) != len(payload):
        raise TranslateError("Translation service returned a different number of texts.")
    for slot, store, text in zip(slots, stores, translated, strict=True):
        out[slot] = _restore(text, store)
    return out


def _plain_to_html(text):
    return html.escape(text or "", quote=False).replace("\n", "<br>")


def _html_to_plain(text):
    text = re.sub(r"<br\s*/?>", "\n", text or "")
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def question(source, targets, text, options):
    """{lang: {"text": html, "options": [{"text", "justification"}]}} for the
    ``targets``; ``source`` "" = detect. ``options``: [{"text",
    "justification"}] (plain text)."""
    options = [o if isinstance(o, dict) else {} for o in (options or [])][:30]
    out = {}
    for target in targets:
        if target not in LANGS or target == source:
            continue
        texts = [text or ""]
        for option in options:
            texts.append(_plain_to_html(str(option.get("text") or "")))
            texts.append(_plain_to_html(str(option.get("justification") or "")))
        done = translate_many(texts, source, target)
        out[target] = {
            "text": done[0],
            "options": [
                {"text": _html_to_plain(done[1 + 2 * i]), "justification": _html_to_plain(done[2 + 2 * i])}
                for i in range(len(options))
            ],
        }
    return out
