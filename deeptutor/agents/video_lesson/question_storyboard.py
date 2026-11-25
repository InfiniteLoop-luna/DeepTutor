"""Build a lesson from the source question and either explanation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from fractions import Fraction
from hashlib import sha256
import json
import re

from deeptutor.services.practice.curriculum import get_curriculum

_MARKUP = re.compile(r"(\$\$.*?\$\$|(?<!\\)\$(?!\$)[^\n$]+(?<!\\)\$|\\\(.*?\\\)|\\\[.*?\\\])", re.S)
_STEP_BOUNDARY = re.compile(r"(?<=[。；！？])\s*|(?<=[.!?;])\s+|(?:\r?\n){2,}")
_FIGURE_REFERENCE = re.compile(
    r"!\[|\b(?:as shown|see (?:the )?figure|the diagram below)\b|"
    r"(?:如|见|根据|结合|观察)(?:题|下|上|左|右|所附)?图|"
    r"(?:图|图象|图像)(?:如|所示)|下列(?:各|四个)?(?:图象|图像|图形)|"
    r"(?:图|图象|图像)(?:略|缺失)|缺(?:少|失)?配图",
    re.I,
)
_PROVENANCE = re.compile(r"^\s*(?:题源[：:]|原件\s*SHA-256[：:]|参考答案根据题干独立推导)")
_BOUND = r"-?(?:\\(?:d?frac)\{\d+\}\{\d+\}|\\(?:d?frac)\d\d|\d+(?:\.\d+)?)"
_INTERVAL = re.compile(
    rf"\s*(?P<low>{_BOUND})\s*(?P<left><|\\leq?|≤)\s*"
    rf"(?P<variable>[a-zA-Z])\s*(?P<right><|\\leq?|≤)\s*(?P<high>{_BOUND})\s*"
)
_LATEX_WORDS = (
    (r"\dfrac", r"\frac"),
    (r"\tfrac", r"\frac"),
    (r"\cdot", "乘以"),
    (r"\times", "乘以"),
    (r"\div", "除以"),
    (r"\leq", "小于等于"),
    (r"\geq", "大于等于"),
    (r"\le", "小于等于"),
    (r"\ge", "大于等于"),
    (r"\neq", "不等于"),
    (r"\ne", "不等于"),
    (r"\pi", "派"),
)


@dataclass(frozen=True)
class LessonBeat:
    id: str
    markdown: str
    narration: str
    interval: dict | None = None
    visual: dict | None = None


@dataclass(frozen=True)
class LessonScene:
    id: str
    kind: str
    beats: list[LessonBeat]
    title: str = ""


def _proof(explanation: str) -> str:
    return "\n".join(
        line for line in explanation.splitlines() if not _PROVENANCE.match(line)
    ).strip()


def needs_figure(entry: dict) -> bool:
    options = (entry.get("options") or {}).values()
    return bool(_FIGURE_REFERENCE.search("\n".join([entry["question"], *options])))


def can_create_lesson(entry: dict) -> bool:
    return bool(entry.get("question", "").strip() and _proof(entry.get("explanation") or ""))


def source_digest(entry: dict) -> str:
    """A changed proof or source invalidates a lesson, a new attempt does not."""
    content = {
        key: entry.get(key)
        for key in (
            "question",
            "options",
            "explanation",
            "correct_answer",
            "textbook_section_id",
            "pdf_sources",
        )
    }
    return sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _speech_formula(tex: str, language: str) -> str:
    fallback = "见屏幕公式" if language == "zh" else "see the formula on screen"
    if language != "zh" or len(tex) > 80:
        return fallback
    tex = (
        tex.strip().removeprefix(r"\(").removesuffix(r"\)").removeprefix(r"\[").removesuffix(r"\]")
    )
    tex = tex.strip("$ ").replace(r"\left", "").replace(r"\right", "")
    for pattern, word in _LATEX_WORDS:
        tex = tex.replace(pattern, word)
    tex = re.sub(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}", r"\2分之\1", tex)
    tex = re.sub(r"\\frac\s*([0-9])\s*([0-9])", r"\2分之\1", tex)
    tex = re.sub(r"\\sqrt\s*\{([^{}]+)\}", r"根号下\1", tex)
    tex = re.sub(r"\\sqrt\s*([0-9])", r"根号\1", tex)
    tex = re.sub(r"\\log_\{([^{}]+)\}\s*", r"以\1为底的对数，真数是", tex)
    tex = re.sub(r"\\log_([0-9a-zA-Z])\s*", r"以\1为底的对数，真数是", tex)
    tex = re.sub(r"\^(?:\{2\}|2(?!\d))", "的平方", tex)
    tex = re.sub(r"\^(?:\{3\}|3(?!\d))", "的立方", tex)
    tex = re.sub(r"\^\{([^{}]+)\}", r"的\1次方", tex)
    tex = re.sub(r"\^(\d+|[a-zA-Z])", r"的\1次方", tex)
    if re.search(r"[\\{}^]", tex):
        return fallback
    for mark, word in (
        ("≤", "小于等于"),
        ("≥", "大于等于"),
        ("≠", "不等于"),
        ("=", "等于"),
        ("<", "小于"),
        (">", "大于"),
        ("+", "加"),
        ("/", "除以"),
    ):
        tex = tex.replace(mark, word)
    tex = re.sub(r"(^|等于|小于|大于|[\(,])-\s*(?=\d)", r"\1负", tex).replace("-", "减")
    return tex


def _narration(markdown: str, language: str) -> str:
    parts = _MARKUP.split(markdown)
    for index in range(0, len(parts), 2):
        part = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", parts[index])
        part = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", part)
        parts[index] = re.sub(r"[*#\x60]", "", part)
    for index in range(1, len(parts), 2):
        parts[index] = _speech_formula(parts[index], language)
    phrase = " ".join("".join(parts).split()).strip()
    return phrase or ("请看画面。" if language == "zh" else "Look at the screen.")


def _steps(proof: str) -> list[str]:
    """Split only prose boundaries so each displayed formula stays intact."""
    units, current = [], ""
    for index, part in enumerate(_MARKUP.split(proof)):
        if index % 2:
            current += part
            continue
        breaks = _STEP_BOUNDARY.split(part)
        current += breaks[0]
        for block in breaks[1:]:
            if current.strip():
                units.append(current.strip())
            current = block
    if current.strip():
        units.append(current.strip())
    return units


def textbook_label(section_id: str) -> str:
    for volume in get_curriculum().volumes:
        for chapter in volume.chapters:
            for section in (chapter, *chapter.sections):
                if section.id == section_id:
                    return f"{volume.title} · {section.number} {section.title}"
    return ""


def _answer_markdown(answer: str) -> str:
    if "$" not in answer and re.match(r"^\\(?:d?frac|sqrt|log|pi)\b", answer):
        return "$" + answer + "$"
    return answer


def _read_bound(text: str) -> Fraction:
    value = re.sub(r"\\d?frac\{(\d+)\}\{(\d+)\}", r"\1/\2", text)
    value = re.sub(r"\\d?frac(\d)(\d)", r"\1/\2", value)
    return Fraction(value)


def _interval(markdown: str) -> dict | None:
    """Draw only a finite range explicitly present in this step."""
    for formula in _MARKUP.findall(markdown):
        tex = formula.strip("$").removeprefix(r"\(").removesuffix(r"\)")
        match = _INTERVAL.fullmatch(tex)
        if not match:
            continue
        try:
            if _read_bound(match["low"]) >= _read_bound(match["high"]):
                continue
        except (ValueError, ZeroDivisionError):
            continue
        return {
            "low": match["low"],
            "high": match["high"],
            "variable": match["variable"],
            "low_closed": match["left"] != "<",
            "high_closed": match["right"] != "<",
        }
    return None


def build_storyboard(
    entry: dict,
    language: str,
    *,
    solved_steps: list[dict] | None = None,
    solved_answer: str = "",
) -> dict:
    proof = _proof(entry.get("explanation") or "")
    if not solved_steps and re.search(r"[\u3400-\u9fff]{2}", proof or entry["question"]):
        language = "zh"
    zh = language == "zh"
    scenes: list[LessonScene] = []

    def add(
        kind: str, *captions: str, prefix: str = "", title: str = "", visual: dict | None = None
    ) -> None:
        scene_id = f"s{len(scenes) + 1}"
        scenes.append(
            LessonScene(
                scene_id,
                kind,
                [
                    LessonBeat(
                        f"{scene_id}-{i}",
                        caption,
                        prefix + _narration(caption, language),
                        _interval(caption) if kind != "question" else None,
                        visual,
                    )
                    for i, caption in enumerate(captions, 1)
                ],
                title,
            )
        )

    question = entry["question"].strip()
    # Keep answer choices as written so the reference answer remains interpretable.
    options = "\n\n".join(
        f"**{key}.** {value}" for key, value in (entry.get("options") or {}).items()
    )
    add("question", *(question, options) if options else (question,))

    reference_answer = (entry.get("correct_answer") or "").strip()
    if solved_steps:
        for step in solved_steps:
            add("step", step["markdown"], title=step["title"], visual=step["visual"])
    else:
        # Two short sentences can reveal one after the other on the same card.
        steps = _steps(proof)
        i = 0
        while i < len(steps):
            first = steps[i]
            if i + 1 < len(steps) and len(first) + len(steps[i + 1]) <= 180:
                add("step", first, steps[i + 1])
                i += 2
            else:
                add("step", first)
                i += 1
    answer = solved_answer or reference_answer
    if answer:
        prefix = "答案是" if zh else "The answer is "
        add("answer", _answer_markdown(answer), prefix=prefix)

    serialized = [asdict(scene) for scene in scenes]
    if solved_steps and not any(
        beat.visual or beat.interval for scene in scenes for beat in scene.beats
    ):
        titles = [step["title"] for step in solved_steps[:3]]
        serialized[1]["beats"][0]["visual"] = {
            "kind": "flow",
            "nodes": [*titles, "核对结论" if zh else "Check the result"],
        }
    return {
        "language": language,
        "source": "ai" if solved_steps else "saved",
        "reference_answer": _answer_markdown(reference_answer) if solved_steps else "",
        "textbook": textbook_label(entry.get("textbook_section_id") or ""),
        "pdf_sources": entry.get("pdf_sources") or [],
        "scenes": serialized,
    }
