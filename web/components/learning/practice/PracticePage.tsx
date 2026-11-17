"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { ArrowRight, CalendarCheck, Check, ClipboardList, FileUp, Loader2 } from "lucide-react";
import { QuestionBankSection } from "@/components/space/question-bank";
import QuestionBankPdfImport from "@/components/space/question-bank/QuestionBankPdfImport";
import { PracticeSets } from "@/components/space/question-bank/PracticeSets";
import SpaceSectionHeader from "@/components/space/SpaceSectionHeader";
import { practiceRoute, questionBankRoute } from "@/lib/learning-routes";
import { getPracticeQueue, getPracticeSummary, type PracticeSummary } from "@/lib/practice-api";
import { LearningErrorState, LearningShell } from "../LearningShell";
import { ReviewHome } from "./ReviewHome";
import { PracticeImport } from "./PracticeImport";
import { PracticeSession } from "./PracticeSession";
import { PracticeInsights } from "./PracticeInsights";

type CollectionView = "bank" | "mistakes" | "documents" | "sets";

const LIBRARY_VIEWS: CollectionView[] = ["bank", "mistakes", "documents", "sets"];
const PRACTICE_VIEWS: CollectionView[] = ["bank", "mistakes"];
const VIEW_LABELS: Record<CollectionView, string> = {
  bank: "Question Bank",
  mistakes: "Mistakes",
  documents: "Sources and import",
  sets: "Practice sets",
};

/** Shared collections and imports; both surfaces can start a manual practice session. */
export function PracticePage({ mode = "practice" }: { mode?: "practice" | "library" }) {
  const search = useSearchParams();
  if (mode === "practice" && !search.has("question")) return <ReviewHome />;
  return <PracticeCollectionPage mode={mode} initialImport={search.get("create") === "1"} />;
}

function PracticeCollectionPage({
  mode,
  initialImport,
}: {
  mode: "practice" | "library";
  initialImport: boolean;
}) {
  const { t } = useTranslation();
  const libraryOnly = mode === "library";
  const pageRoute = libraryOnly ? questionBankRoute : practiceRoute;
  const router = useRouter();
  const search = useSearchParams();
  const views = libraryOnly ? LIBRARY_VIEWS : PRACTICE_VIEWS;
  const tab = views.find(view => view === search.get("view")) ?? "bank";
  const pdfSourceId = tab === "bank" ? (search.get("pdf_source") ?? undefined) : undefined;
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(initialImport);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<number[] | null>(() => {
    const id = Number(search.get("question"));
    return Number.isSafeInteger(id) && id > 0 ? [id] : null;
  });
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const summarySequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++summarySequence.current;
    try {
      const result = await getPracticeSummary();
      if (sequence === summarySequence.current) {
        setSummary(result);
        setError("");
      }
    } catch (err) {
      if (sequence === summarySequence.current)
        setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 60000);
    return () => {
      // Invalidate pending requests after this scope is replaced.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      summarySequence.current++;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);
  function closeSession() {
    setSession(null);
    setRevision(value => value + 1);
    void refresh();
  }
  async function startReview() {
    if (pending.current) return;
    pending.current = true;
    setStarting(true);
    setNotice("");
    try {
      const queue = await getPracticeQueue();
      if (queue.length) setSession(queue.map(item => item.entry.id));
      else {
        setNotice(t("You are caught up. Come back when your next reviews are due."));
        void refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setStarting(false);
    }
  }
  function switchTab(view: CollectionView, pdfSource?: string) {
    const next = new URLSearchParams(search.toString());
    next.set("view", view);
    if (pdfSource) next.set("pdf_source", pdfSource);
    else next.delete("pdf_source");
    next.delete("create");
    next.delete("question");
    setImportOpen(false);
    router.replace(pageRoute(next), { scroll: false });
  }
  function imported(message?: string) {
    if (message) setNotice(message);
    setRevision(value => value + 1);
    void refresh();
  }
  return (
    <PracticePageShell
      libraryOnly={libraryOnly}
      action={
        !session && (
          <button
            type="button"
            onClick={() => {
              if (libraryOnly && tab !== "mistakes") switchTab("documents");
              else setImportOpen(open => !open);
            }}
            aria-expanded={tab === "documents" || importOpen}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-muted"
          >
            <FileUp size={16} />
            {t("Import questions")}
          </button>
        )
      }
    >
      {session ? (
        <PracticeSession
          ids={session}
          onClose={closeSession}
          backLabel={libraryOnly ? t("Back to library") : undefined}
        />
      ) : (
        <>
          {notice && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-500/10 p-3 text-sm"
            >
              <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />
              {notice}
            </div>
          )}
          {importOpen && tab !== "documents" && (
            <PracticeImport
              key={tab}
              initialTarget={tab === "mistakes" ? "mistakes" : "bank"}
              onClose={() => setImportOpen(false)}
              onImported={message => {
                setImportOpen(false);
                imported(message);
              }}
            />
          )}
          {error && <LearningErrorState message={error} onRetry={() => void refresh()} />}
          {!libraryOnly && <PracticeInsights revision={revision} />}
          {!libraryOnly && (
            <section
              aria-labelledby="practice-today"
              className="mb-7 rounded-2xl border border-border bg-card p-5 sm:p-6"
            >
              <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
                <div className="flex items-start gap-4">
                  <div className="rounded-xl bg-emerald-500/10 p-3 text-emerald-600 dark:text-emerald-400">
                    <CalendarCheck size={22} />
                  </div>
                  <div>
                    <h2 id="practice-today" className="text-base font-semibold">
                      {t("Today's review")}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {summary
                        ? summary.due > 0
                          ? t("{{count}} questions are ready to revisit.", { count: summary.due })
                          : t("You are caught up. Come back when your next reviews are due.")
                        : t("Loading…")}
                    </p>
                    {summary && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("{{done}} reviewed today · {{overdue}} overdue", {
                          done: summary.reviewed_today,
                          overdue: summary.overdue,
                        })}
                        {summary.due === 0 && summary.next_due_at && (
                          <>
                            {" "}
                            ·{" "}
                            {t("Next review: {{date}}", {
                              date: new Date(summary.next_due_at * 1000).toLocaleDateString(),
                            })}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void startReview()}
                  disabled={starting || !summary?.due || !!error}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
                >
                  {starting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                  {t("Start today's review")}
                </button>
              </div>
              <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                {t(
                  "New mistakes return the next day. Reviews adapt to your recall; overdue questions come first. Work in sets of up to 20.",
                )}
              </p>
            </section>
          )}
          <div
            role="tablist"
            aria-label={t("Practice collections")}
            className="mb-5 flex gap-5 overflow-x-auto border-b border-border"
          >
            {views.map((view, index) => (
              <button
                key={view}
                id={`practice-tab-${view}`}
                type="button"
                role="tab"
                aria-selected={tab === view}
                tabIndex={tab === view ? 0 : -1}
                onKeyDown={event => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    const direction = event.key === "ArrowLeft" ? -1 : 1;
                    const next = views[(index + direction + views.length) % views.length];
                    switchTab(next);
                    document.getElementById(`practice-tab-${next}`)?.focus();
                  }
                }}
                aria-controls="practice-collection"
                onClick={() => switchTab(view)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm ${tab === view ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t(VIEW_LABELS[view])}
                {(view === "bank" || view === "mistakes") && (
                  <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                    {summary ? (view === "bank" ? summary.total : summary.mistakes) : "—"}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div id="practice-collection" role="tabpanel" aria-labelledby={`practice-tab-${tab}`}>
            {tab === "documents" ? (
              <QuestionBankImportWorkspace
                onImported={imported}
                onBrowseSource={id => switchTab("bank", id)}
              />
            ) : tab === "sets" ? (
              <PracticeSets onStart={setSession} />
            ) : (
              <QuestionBankSection
                key={`${tab}:${revision}:${pdfSourceId ?? ""}`}
                embedded
                onChanged={refresh}
                mistakesOnly={tab === "mistakes"}
                pdfSourceId={pdfSourceId}
                onClearPdfSource={() => switchTab("bank")}
                onPractice={ids => {
                  setSession(ids);
                  setNotice("");
                }}
              />
            )}
          </div>
        </>
      )}
    </PracticePageShell>
  );
}

function QuestionBankImportWorkspace({
  onImported,
  onBrowseSource,
}: {
  onImported: (message?: string) => void;
  onBrowseSource: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [structured, setStructured] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {([false, true] as const).map(value => (
          <button
            type="button"
            key={String(value)}
            aria-pressed={value === structured}
            onClick={() => setStructured(value)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${value === structured ? "border-primary/30 bg-primary/10 font-medium text-primary" : "border-border hover:bg-muted"}`}
          >
            {t(value ? "Spreadsheet or JSON" : "PDF sources")}
          </button>
        ))}
      </div>
      {structured ? (
        <PracticeImport
          initialTarget="bank"
          onClose={() => setStructured(false)}
          onImported={onImported}
        />
      ) : (
        <QuestionBankPdfImport onImported={() => onImported()} onBrowseSource={onBrowseSource} />
      )}
    </div>
  );
}

function PracticePageShell({
  libraryOnly,
  action,
  children,
}: {
  libraryOnly: boolean;
  action: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (libraryOnly) {
    // SpaceMain supplies the Learning Space breadcrumb and page scroll container.
    return (
      <>
        <SpaceSectionHeader
          title={t("Question Bank")}
          description={t(
            "Browse textbook chapters, review source documents, and put together practice sets.",
          )}
          action={action}
        />
        {children}
      </>
    );
  }
  return (
    <LearningShell
      title={t("Practice")}
      subtitle={t("Collect what you learn. Practice what matters. Remember it for longer.")}
      action={action}
    >
      {children}
    </LearningShell>
  );
}
