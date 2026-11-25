"use client";

import { memo, useEffect, useRef } from "react";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import type { LessonBeat, LessonCoordinates, LessonCurve, LessonScene } from "@/lib/question-lesson-api";

export function useSceneTitle() {
  const { t } = useTranslation();
  return (scene: LessonScene, index: number) =>
    scene.title ||
    (scene.kind === "question"
      ? t("Read the question")
      : scene.kind === "answer"
        ? t("Check the answer")
        : t("Solution step {{step}}", { step: index }));
}

export const LessonText = memo(function LessonText({ markdown, size }: { markdown: string; size: number }) {
  return (
    <MarkdownRenderer
      content={markdown}
      learningTextSize={size}
      variant="compact"
      enableMath
      enableImages={false}
      enableCode={false}
      enableMermaid={false}
      allowHtml={false}
      className="!text-inherit [&_p]:!my-0 [&_.katex-display]:my-1"
    />
  );
});

const INK = "#17233b";
const ACCENTS = ["#14736a", "#9a4d26", "#5259a7", "#785680", "#5f692a"];
const W = 720;
const H = 400;
const PAD = 42;
const FUNCTIONS = {
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  exp: Math.exp,
  log: Math.log,
  sqrt: Math.sqrt,
  reciprocal: (x: number) => 1 / x,
};

function curveValue(curve: LessonCurve, x: number) {
  return curve.function === "polynomial"
    ? (curve.coefficients ?? []).reduceRight((value, coefficient) => value * x + coefficient, 0)
    : curve.a * FUNCTIONS[curve.function](curve.b * (x - curve.h)) + curve.k;
}

function ticks(min: number, max: number) {
  const target = (max - min) / 6;
  const scale = 10 ** Math.floor(Math.log10(target));
  const step = ([1, 2, 5, 10].find(unit => unit * scale >= target) ?? 10) * scale;
  const start = Math.ceil(min / step);
  const count = Math.max(0, Math.floor(max / step) - start + 1);
  return Array.from({ length: count }, (_, index) => (start + index) * step);
}

function drawCoordinates(ctx: CanvasRenderingContext2D, plot: LessonCoordinates) {
  const [xMin, xMax] = plot.x_range;
  const [yMin, yMax] = plot.y_range;
  const xScale = (W - 2 * PAD) / (xMax - xMin);
  const yScale = (H - 2 * PAD) / (yMax - yMin);
  const uniformScale = Math.min(xScale, yScale);
  const x = (value: number) => W / 2 + (value - (xMin + xMax) / 2) * (plot.axes ? xScale : uniformScale);
  const y = (value: number) => H / 2 - (value - (yMin + yMax) / 2) * (plot.axes ? yScale : uniformScale);
  function line(x1: number, y1: number, x2: number, y2: number) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.fillStyle = "#f6faf8";
  ctx.fillRect(0, 0, W, H);
  ctx.font = '17px system-ui, "Microsoft YaHei", sans-serif';
  ctx.lineCap = "round";
  if (plot.axes) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#dce7e3";
    ctx.fillStyle = "#536461";
    ctx.textAlign = "center";
    for (const tick of ticks(xMin, xMax)) {
      line(x(tick), PAD, x(tick), H - PAD);
      ctx.fillText(String(Number(tick.toPrecision(4))), x(tick), H - PAD + 22);
    }
    ctx.textAlign = "right";
    for (const tick of ticks(yMin, yMax)) {
      line(PAD, y(tick), W - PAD, y(tick));
      ctx.fillText(String(Number(tick.toPrecision(4))), PAD - 7, y(tick) + 5, PAD - 9);
    }
    ctx.strokeStyle = "#6c827b";
    ctx.lineWidth = 1.6;
    if (yMin <= 0 && yMax >= 0) line(PAD, y(0), W - PAD, y(0));
    if (xMin <= 0 && xMax >= 0) line(x(0), PAD, x(0), H - PAD);
    ctx.fillText("x", W - 13, H - PAD + 22);
    ctx.fillText("y", PAD - 8, PAD - 13);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
  ctx.clip();
  plot.curves.forEach((curve, index) => {
    ctx.beginPath();
    ctx.strokeStyle = ACCENTS[index];
    ctx.lineWidth = 3.6;
    let last = NaN;
    for (let i = 0; i <= 640; i += 1) {
      const tick = xMin + (xMax - xMin) * (i / 640);
      const value = y(curveValue(curve, tick));
      if (!Number.isFinite(value) || Math.abs(value) > H * 50) {
        last = NaN;
        continue;
      }
      if (Math.abs(value - last) < H) ctx.lineTo(x(tick), value);
      else ctx.moveTo(x(tick), value);
      last = value;
    }
    ctx.stroke();
  });
  ctx.restore();

  const points = new Map(plot.points.map(point => [point.label, point]));
  ctx.strokeStyle = ACCENTS[0];
  ctx.lineWidth = 3;
  for (const [first, second] of plot.segments) {
    const a = points.get(first);
    const b = points.get(second);
    if (a && b) line(x(a.x), y(a.y), x(b.x), y(b.y));
  }
  ctx.fillStyle = INK;
  ctx.font = 'bold 19px system-ui, "Microsoft YaHei", sans-serif';
  for (const point of plot.points) {
    const px = x(point.x);
    const py = y(point.y);
    ctx.textAlign = px > W - 115 ? "right" : "left";
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillText(point.label, px + (ctx.textAlign === "right" ? -10 : 10), py - 8, 140);
  }
}

function Coordinates({ plot }: { plot: LessonCoordinates }) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) drawCoordinates(ctx, plot);
  }, [plot]);

  return (
    <figure className="min-w-0 overflow-hidden rounded-xl border border-[#d5e1db] bg-[#f6faf8] text-[#17233b]">
      <canvas
        ref={canvas}
        role="img"
        aria-label={t(plot.axes ? "Function graph" : "Geometry diagram")}
        width={W}
        height={H}
        className="h-auto w-full"
      />
      {plot.curves.length > 0 && (
        <figcaption className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-2 text-sm">
          {plot.curves.map((curve, index) => (
            <span key={index} className="flex items-center gap-1.5 break-all">
              <span aria-hidden className="h-1 w-4 shrink-0 rounded" style={{ background: ACCENTS[index] }} />
              {curve.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

function IntervalLine({ interval, size }: { interval: NonNullable<LessonBeat["interval"]>; size: number }) {
  const { t } = useTranslation();
  return (
    <div role="img" aria-label={t("Number line")} className="relative mx-auto mt-3 h-20 w-[74%] text-[#17233b]">
      <div className="absolute inset-x-0 top-5 h-0.5 bg-[#40536a]" />
      <div className="absolute right-0 top-[14px] h-3.5 w-3.5 rotate-45 border-r-2 border-t-2 border-[#40536a]" />
      <div className="absolute left-[24%] right-[24%] top-[18px] h-1 rounded-full bg-[#267a66]" />
      <span className="absolute -right-5 top-6 text-lg italic">{interval.variable}</span>
      {[
        { label: interval.low, closed: interval.low_closed, position: "left-[24%]" },
        { label: interval.high, closed: interval.high_closed, position: "left-[76%]" },
      ].map(mark => (
        <div key={mark.position} className={`absolute top-[12px] -translate-x-1/2 text-center ${mark.position}`}>
          <div className={`mx-auto size-4 rounded-full border-[3px] border-[#267a66] ${mark.closed ? "bg-[#267a66]" : "bg-[#f6faf8]"}`} />
          <LessonText markdown={"$" + mark.label + "$"} size={size} />
        </div>
      ))}
    </div>
  );
}

export function LessonVisual({ beat, size = 16 }: { beat: LessonBeat; size?: number }) {
  const visual = beat.visual;
  if (visual?.kind === "coordinates") return <Coordinates plot={visual} />;
  if (beat.interval) {
    return (
      <div className="overflow-hidden rounded-xl border border-[#d5e1db] bg-[#f6faf8]">
        <IntervalLine interval={beat.interval} size={size} />
      </div>
    );
  }
  if (visual?.kind !== "flow") return null;
  return (
    <ol className="space-y-1.5 rounded-xl border border-[#d5e1db] bg-[#f6faf8] p-3 text-center text-[#17233b]">
      {visual.nodes.map((node, index) => (
        <li key={index}>
          {index > 0 && <ArrowDown aria-hidden size={size} className="mx-auto mb-1 text-[#267a66]" />}
          <div className="rounded-md border border-[#d5e1db] bg-white px-2 py-1.5">
            <LessonText markdown={node} size={size} />
          </div>
        </li>
      ))}
    </ol>
  );
}
