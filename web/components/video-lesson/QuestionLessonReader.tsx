"use client";

import Image from "next/image";
import { useTranslation } from "react-i18next";
import { questionLessonFigureUrl, type QuestionLesson } from "@/lib/question-lesson-api";
import { LessonText, LessonVisual, useSceneTitle } from "./QuestionLessonContent";

export default function QuestionLessonReader({ lesson }: { lesson: QuestionLesson }) {
  const { t } = useTranslation();
  const title = useSceneTitle();
  const [question, ...steps] = lesson.scenes;

  return (
    <div className="space-y-3">
      <details className="rounded-xl border border-border bg-muted/30 p-3.5">
        <summary className="cursor-pointer text-sm font-medium">{t("Read the question")}</summary>
        <div className="mt-3 space-y-2">
          {question.beats.map(beat => <LessonText key={beat.id} markdown={beat.markdown} size={16} />)}
          {lesson.has_figure && (
            <Image
              src={questionLessonFigureUrl(lesson)}
              unoptimized
              width={600}
              height={360}
              alt={t("Question figure")}
              className="max-h-[55vh] w-auto max-w-full rounded-lg object-contain"
            />
          )}
        </div>
      </details>
      {lesson.textbook && <p className="text-sm text-muted-foreground">{lesson.textbook}</p>}
      <ol className="space-y-3">
        {steps.map((scene, index) => (
          <li
            key={scene.id}
            className={`min-w-0 space-y-2 rounded-xl border p-3.5 sm:p-4 ${scene.kind === "answer" ? "border-primary/30 bg-primary/5" : "border-border"}`}
          >
            <h3 className="text-sm font-semibold text-foreground">{title(scene, index + 1)}</h3>
            {scene.beats.map(beat => (
              <div
                key={beat.id}
                className={beat.visual || beat.interval ? "grid items-start gap-3 sm:grid-cols-2" : "min-w-0"}
              >
                <div className="min-w-0">
                  <LessonText markdown={beat.markdown} size={16} />
                </div>
                <LessonVisual beat={beat} />
              </div>
            ))}
            {scene.kind === "answer" && lesson.reference_answer && (
              <details className="mt-2 border-t border-border pt-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">{t("Question bank reference answer")}</summary>
                <div className="mt-2"><LessonText markdown={lesson.reference_answer} size={15} /></div>
              </details>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
