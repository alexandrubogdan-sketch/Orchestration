"use client";

import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getMockAudienceLists } from "@/lib/mock-data";
import { AUDIENCE_LIST_TYPE_LABELS } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/**
 * Mirrors the real client's lists-list.component.tsx: name / type /
 * author / created-at columns. These lists are a visual/structural
 * stand-in only (see lib/types.ts's AudienceList doc comment) — no
 * create/edit/delete flow yet, so this table is read-only, unlike
 * WorkflowsTable's row actions.
 */
export function ListsTable() {
  const lists = getMockAudienceLists();

  if (lists.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">No lists yet</p>
        <p className="text-sm text-muted-foreground">
          Lists let workflow conditions match against a reusable set of values.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH className="min-w-[280px]">Name</TH>
          <TH className="w-[120px]">Type</TH>
          <TH className="w-[100px]">Entries</TH>
          <TH className="min-w-[200px]">Author</TH>
          <TH className="w-[180px]">Created</TH>
        </TR>
      </THead>
      <TBody>
        {lists.map((list) => (
          <TR key={list.id}>
            <TD className="min-w-[280px] max-w-[280px]">
              <p className="truncate text-sm font-medium">{list.name}</p>
              <p className="truncate text-xs text-zinc-500">{list.id}</p>
            </TD>
            <TD className="w-[120px]">
              <Badge tone="neutral">{AUDIENCE_LIST_TYPE_LABELS[list.type]}</Badge>
            </TD>
            <TD className="w-[100px] text-sm text-muted-foreground">
              {list.entryCount.toLocaleString("en-US")}
            </TD>
            <TD className="min-w-[200px]">
              <p className="text-sm">{list.authorName}</p>
              <p className="text-xs text-zinc-500">{list.authorEmail}</p>
            </TD>
            <TD className="w-[180px] text-sm text-muted-foreground">
              {formatDateTime(list.createdAt)}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
