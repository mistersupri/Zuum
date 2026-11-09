import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { Meeting } from "../lib/types";
import { Button, EmptyState, ErrorState, Input, LoadingBlock, Select } from "../components/ui";
import { MeetingRow } from "../components/MeetingList";

export function HistoryPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [scope, setScope] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useInfiniteQuery({
    queryKey: ["meetings", "history", debounced, status, scope, from, to],
    queryFn: ({ pageParam }) =>
      api<{ items: Meeting[]; nextCursor: string | null }>("/meetings", {
        query: {
          q: debounced,
          status,
          scope,
          from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
          to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
          cursor: pageParam,
          limit: 20,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(debounced || status || from || to || scope !== "all");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Riwayat rapat</h1>
        <p className="mt-1 text-muted">Cari berdasarkan judul atau isi transkrip.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <MagnifyingGlass size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input aria-label="Cari rapat" placeholder="Cari judul atau kata di transkrip" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
        </div>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Semua status</option>
          <option value="LIVE">Berlangsung</option>
          <option value="SCHEDULED">Terjadwal</option>
          <option value="ENDED">Selesai</option>
          <option value="CANCELLED">Dibatalkan</option>
        </Select>
        <Select aria-label="Pemilik" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">Semua rapat</option>
          <option value="owned">Rapat saya</option>
          <option value="joined">Yang saya ikuti</option>
        </Select>
        <Input aria-label="Dari tanggal" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input aria-label="Sampai tanggal" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {list.isLoading ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={filtered ? "Tidak ada rapat yang cocok" : "Belum ada rapat"}>
          {filtered ? "Coba kata kunci lain atau longgarkan filter." : "Rapat yang Anda buat atau ikuti akan tercatat di sini."}
        </EmptyState>
      ) : (
        <>
          <ul className="-mx-3 divide-y divide-line sm:-mx-4">{items.map((m) => <MeetingRow key={m.id} m={m} />)}</ul>
          {list.hasNextPage && (
            <div>
              <Button variant="secondary" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                Muat lebih banyak
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
