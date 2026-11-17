"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  loadPdfjs,
  pdfjsCMapUrl,
  pdfjsWasmUrl,
  type PdfDocument,
  type PdfPageProxy,
  type Pdfjs,
} from "@/lib/pdfjs-loader";

function PdfImportCanvas({ document, page }: { document: PdfDocument; page: number }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    let render: ReturnType<PdfPageProxy["render"]> | undefined;
    void document.getPage(page).then(async originalPage => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;

      const size = originalPage.getViewport({ scale: 1 });
      const scale = 1600 / Math.max(size.width, size.height);
      const viewport = originalPage.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      render = originalPage.render({ canvas, viewport });
      await render.promise;
      if (!cancelled) setStatus("ready");
    }).catch(() => {
      if (!cancelled) setStatus("failed");
    });

    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [document, page]);

  return (
    <>
      {status === "loading" && <PreviewLoading />}
      {status === "failed" && <PreviewFailed />}
      <canvas
        ref={canvasRef}
        hidden={status !== "ready"}
        role="img"
        aria-label={t("Original PDF page {{page}}", { page })}
        className="mx-auto h-auto max-w-full bg-white shadow-sm"
      />
    </>
  );
}

function PreviewLoading() {
  const { t } = useTranslation();
  return (
    <p role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 size={16} className="animate-spin" />
      {t("Loading PDF preview…")}
    </p>
  );
}

function PreviewFailed() {
  const { t } = useTranslation();
  return (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {t("Could not preview this page. Open the original PDF to check it.")}
    </p>
  );
}

export default function PdfImportPreview({
  url,
  page,
  pageCount,
  onPageChange,
}: {
  url: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ url: string; document: PdfDocument | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Pdfjs["getDocument"]> | undefined;
    void loadPdfjs().then(async pdfjs => {
      if (cancelled) return;
      task = pdfjs.getDocument({
        url,
        withCredentials: true,
        rangeChunkSize: 1 << 20,
        wasmUrl: pdfjsWasmUrl(),
        cMapUrl: pdfjsCMapUrl(),
        cMapPacked: true,
      });
      const document = await task.promise;
      if (!cancelled) setLoaded({ url, document });
    }).catch(() => {
      if (!cancelled) setLoaded({ url, document: null });
    });

    return () => {
      cancelled = true;
      void task?.destroy().catch(() => {});
    };
  }, [url]);

  const count = loaded?.url === url ? loaded.document?.numPages ?? pageCount : pageCount;
  const currentPage = Math.max(1, Math.min(page, count || 1));

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/20" aria-label={t("Original PDF")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            aria-label={t("Previous page")}
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </button>
          <span>{count ? t("Page {{page}} of {{pages}}", { page: currentPage, pages: count }) : t("Original PDF")}</span>
          <button
            type="button"
            aria-label={t("Next page")}
            disabled={!count || currentPage >= count}
            onClick={() => onPageChange(currentPage + 1)}
            className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <a
          href={`${url}#page=${currentPage}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-primary/10"
        >
          {t("Open original PDF")}
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
      <div className="max-h-[60vh] overflow-auto p-3 lg:max-h-[75vh]">
        {loaded?.url !== url ? (
          <PreviewLoading />
        ) : loaded.document ? (
          <PdfImportCanvas key={currentPage} document={loaded.document} page={currentPage} />
        ) : (
          <PreviewFailed />
        )}
      </div>
    </section>
  );
}
