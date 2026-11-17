"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TextbookCatalog } from "@/lib/notebook-api";

type TextbookNode = { id: string; label: string; children?: TextbookNode[] };

export function TextbookSectionOptions({ catalog }: { catalog: TextbookCatalog }) {
  return catalog.volumes.map(volume => (
    <optgroup key={volume.id} label={volume.title}>
      {volume.chapters.flatMap(chapter =>
        [chapter, ...chapter.sections].map(section => (
          <option value={section.id} key={section.id}>
            {section.number} {section.title}
          </option>
        )),
      )}
    </optgroup>
  ));
}

export function textbookSectionLabel(catalog: TextbookCatalog | null, id: string) {
  for (const volume of catalog?.volumes ?? []) {
    for (const chapter of volume.chapters) {
      const section = chapter.id === id ? chapter : chapter.sections.find(item => item.id === id);
      if (section) return `${volume.title} · ${section.number} ${section.title}`;
    }
  }
  return "";
}

function containsNode(nodes: TextbookNode[], id: string): boolean {
  return nodes.some(node => node.id === id || (node.children && containsNode(node.children, id)));
}

function CurriculumBranch({
  node,
  value,
  onChange,
}: {
  node: TextbookNode;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(
    () => value === node.id || containsNode(node.children ?? [], value),
  );
  const Arrow = open ? ChevronDown : ChevronRight;
  const active = value === node.id;
  return (
    <li>
      <div className="flex items-center gap-1">
        {node.children && node.children.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("Expand or collapse {{title}}", { title: node.label })}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
            onClick={() => setOpen(!open)}
          >
            <Arrow size={14} />
          </button>
        ) : (
          <span className="w-7 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => {
            onChange(node.id);
            if (node.children?.length) setOpen(true);
          }}
          aria-pressed={active}
          className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-[13px] leading-snug ${active ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`}
        >
          {node.label}
        </button>
      </div>
      {open && node.children && node.children.length > 0 && (
        <ul className="ml-3.5 space-y-0.5 border-l border-border pl-1.5">
          {node.children.map(child => (
            <CurriculumBranch key={child.id} node={child} value={value} onChange={onChange} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function BankCurriculum({
  catalog,
  value,
  onChange,
}: {
  catalog: TextbookCatalog;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const nodes: TextbookNode[] = [
    { id: "", label: t("All questions") },
    { id: "unassigned", label: t("Awaiting classification") },
    ...catalog.volumes.map(volume => ({
      id: volume.id,
      label: volume.title,
      children: volume.chapters.map(chapter => ({
        id: chapter.id,
        label: `${chapter.number} ${chapter.title}`,
        children: chapter.sections.map(section => ({
          id: section.id,
          label: `${section.number} ${section.title}`,
        })),
      })),
    })),
  ];
  return (
    <nav
      aria-label={t("Textbook contents")}
      className="min-w-0 self-start rounded-xl border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
        <BookOpen size={16} className="text-primary" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("Textbook contents")}</h2>
          <p className="text-xs text-muted-foreground">{catalog.edition}</p>
        </div>
      </div>
      <ul className="max-h-[55vh] space-y-0.5 overflow-y-auto p-2">
        {nodes.map(node => (
          <CurriculumBranch key={node.id} node={node} value={value} onChange={onChange} />
        ))}
      </ul>
    </nav>
  );
}
