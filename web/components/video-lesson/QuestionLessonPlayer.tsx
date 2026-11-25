"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Player, type CallbackListener, type PlayerRef } from "@remotion/player";
import { AbsoluteFill, Html5Audio, Img, Sequence, useCurrentFrame } from "remotion";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import {
  type QuestionLesson,
  questionLessonAudioUrl,
  questionLessonFigureUrl,
} from "@/lib/question-lesson-api";
import { LessonText, LessonVisual, useSceneTitle } from "./QuestionLessonContent";

const FPS = 30;
const LEAD = 8;
const HOLD = 15;
const WIDTH = 1280;
const HEIGHT = 720;

function sceneTimeline(lesson: QuestionLesson) {
  let start = 0;
  return lesson.scenes.map((scene, index) => {
    let position = LEAD;
    const beats = scene.beats.map(beat => {
      const at = position;
      position += beat.frames + HOLD;
      return { ...beat, at, src: beat.recording ? questionLessonAudioUrl(lesson, beat) : "" };
    });
    const result = { ...scene, index, start, duration: position, beats };
    start += position;
    return result;
  });
}

type TimedScene = ReturnType<typeof sceneTimeline>[number];

function LessonSceneView({
  scene,
  title,
  textbook,
  figure,
}: {
  scene: TimedScene;
  title: string;
  textbook: string;
  figure: string;
}) {
  const frame = useCurrentFrame();
  const active = Math.max(
    0,
    scene.beats.findLastIndex(beat => beat.at <= frame),
  );
  const current = scene.beats[active];
  const caption = current.captions.findLast(([at]) => current.at + at <= frame)?.[1] ?? "";
  const hasVisual = !!(current.visual || current.interval);
  const showFigure = !hasVisual && scene.kind !== "answer" && !!figure;
  const hasSide = showFigure || hasVisual;
  const length = scene.beats.reduce((sum, beat) => sum + beat.markdown.length, 0);
  const textSize = length > 760 ? 22 : length > 420 ? 26 : length > 215 || hasSide ? 31 : 40;

  return (
    <AbsoluteFill className="bg-[#f9f7f1] text-[#17233b]" style={{ padding: "34px 56px 110px" }}>
      <div className="mb-5 flex items-baseline justify-between gap-6 border-b border-[#d5dcca] pb-4">
        <h3 className="line-clamp-2 min-w-0 font-semibold" style={{ fontSize: title.length > 45 ? 28 : 37 }}>
          {title}
        </h3>
        {textbook && (
          <p className="truncate text-[#40536a]" style={{ fontSize: 24 }}>
            {textbook}
          </p>
        )}
      </div>
      <div
        className={`grid min-h-0 flex-1 gap-6 ${hasSide ? "grid-cols-[minmax(0,1fr)_38%]" : ""}`}
      >
        <div className="max-h-full space-y-4 self-center overflow-auto">
          {scene.beats.slice(0, active + 1).map((beat, index) => (
            <div
              key={beat.id}
              style={{ fontSize: textSize }}
              className={`rounded-r-xl border-l-4 px-5 py-3 leading-relaxed ${index === active ? "border-[#267a66] bg-white" : "border-transparent"}`}
            >
              <LessonText markdown={beat.markdown} size={textSize} />
            </div>
          ))}
        </div>
        {hasVisual && (
          <div className="max-h-full self-center overflow-auto">
            <LessonVisual beat={current} size={22} />
          </div>
        )}
        {showFigure && (
          <Img src={figure} className="h-full min-h-0 w-full rounded-lg object-contain" />
        )}
      </div>
      {scene.beats.map(
        beat =>
          beat.src && (
            <Sequence key={beat.id} from={beat.at} durationInFrames={beat.frames} layout="none">
              <Html5Audio src={beat.src} pauseWhenBuffering />
            </Sequence>
          ),
      )}
      {caption && (
        <div
          className="absolute inset-x-14 bottom-8 grid min-h-14 place-items-center rounded-lg bg-[#17233b] px-8 py-2 text-center text-white"
          style={{ fontSize: caption.length > 92 ? 23 : 27 }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
}

function QuestionLessonComposition({
  scenes,
  textbook,
  figure,
}: {
  scenes: TimedScene[];
  textbook: string;
  figure: string;
}) {
  const title = useSceneTitle();
  return scenes.map(scene => (
    <Sequence key={scene.id} from={scene.start} durationInFrames={scene.duration}>
      <LessonSceneView
        scene={scene}
        title={title(scene, scene.index)}
        textbook={textbook}
        figure={figure}
      />
    </Sequence>
  ));
}

export default function QuestionLessonPlayer({
  lesson,
  onRetry,
  busy,
}: {
  lesson: QuestionLesson;
  onRetry: (sceneId: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const title = useSceneTitle();
  const player = useRef<PlayerRef>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const scenes = useMemo(() => sceneTimeline(lesson), [lesson]);
  const selected = scenes[Math.min(activeIndex, scenes.length - 1)];
  const duration = scenes[scenes.length - 1].start + scenes[scenes.length - 1].duration;

  useEffect(() => {
    const current = player.current;
    const update: CallbackListener<"frameupdate"> = ({ detail }) =>
      setActiveIndex(
        Math.max(
          0,
          scenes.findLastIndex(scene => scene.start <= detail.frame),
        ),
      );
    current?.addEventListener("frameupdate", update);
    return () => current?.removeEventListener("frameupdate", update);
  }, [scenes]);

  return (
    <div className="space-y-3">
      <Player
        ref={player}
        component={QuestionLessonComposition}
        inputProps={{
          scenes,
          textbook: lesson.textbook,
          figure: lesson.has_figure ? questionLessonFigureUrl(lesson) : "",
        }}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        durationInFrames={duration}
        fps={FPS}
        controls
        clickToPlay
        showVolumeControls
        allowFullscreen
        style={{
          width: "100%",
          maxWidth: "calc(max(150px, 100dvh - 165px) * 1.7778)",
          marginInline: "auto",
          aspectRatio: "16 / 9",
          borderRadius: 12,
          overflow: "hidden",
        }}
      />
      <nav aria-label={t("Lesson steps")} className="flex flex-wrap gap-2">
        {scenes.map(scene => (
          <button
            type="button"
            key={scene.id}
            aria-pressed={scene.id === selected.id}
            className={`rounded-md border px-2.5 py-1.5 text-xs ${scene.id === selected.id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-muted"}`}
            onClick={() => {
              player.current?.seekTo(scene.start);
              setActiveIndex(scene.index);
            }}
          >
            {title(scene, scene.index)}
            {scene.state === "caption" ? ` · ${t("Captions only")}` : ""}
          </button>
        ))}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("Read this step")}
          </summary>
          <div className="mt-2 space-y-2">
            {selected.beats.map(beat => (
              <LessonText key={beat.id} markdown={beat.markdown} size={16} />
            ))}
          </div>
        </details>
        <button
          type="button"
          disabled={busy || selected.state === "recording"}
          onClick={() => {
            player.current?.pause();
            player.current?.seekTo(selected.start);
            onRetry(selected.id);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw size={13} />
          {selected.state === "recording" ? t("Recording this step…") : t("Record this step again")}
        </button>
      </div>
    </div>
  );
}
