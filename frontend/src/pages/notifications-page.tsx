import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, CheckCheck, ChevronRight, ClipboardList, FileText, FolderKanban, Inbox, MessageSquare, Package, Shield, type LucideIcon } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Pagination } from "@/components/pagination"
import { usePageMeta } from "@/hooks/use-page-meta"
import { notificationClient, type NotificationItem } from "@/lib/notification-client"
import { cn } from "@/lib/utils"

type Filter = "all" | "unread"

const kinds: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  quotation: { label: "Báo giá", icon: FileText, tone: "bg-orange-50 text-orange-700" },
  order: { label: "Đơn hàng", icon: Package, tone: "bg-emerald-50 text-emerald-800" },
  work_order: { label: "Dự án", icon: FolderKanban, tone: "bg-emerald-950 text-emerald-50" },
  lead: { label: "Khách mới", icon: Inbox, tone: "bg-amber-50 text-amber-800" },
  request: { label: "Yêu cầu", icon: ClipboardList, tone: "bg-slate-100 text-slate-700" },
  support: { label: "Hỗ trợ", icon: MessageSquare, tone: "bg-orange-50 text-orange-800" },
  privacy: { label: "Tài khoản", icon: Shield, tone: "bg-slate-100 text-slate-700" },
}

const fallbackKind = { label: "Cập nhật", icon: Bell, tone: "bg-slate-100 text-slate-600" }

function kindOf(type: string) {
  return kinds[type.split(".")[0]] || fallbackKind
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(iso: string) {
  const day = startOfDay(new Date(iso))
  const diff = Math.round((startOfDay(new Date()) - day) / 86_400_000)
  if (diff <= 0) return "Hôm nay"
  if (diff === 1) return "Hôm qua"
  return new Date(iso).toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "long" })
}

function relativeTime(iso: string) {
  const date = new Date(iso)
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000)
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  if (dayDiff <= 0) {
    if (minutes < 1) return "Vừa xong"
    if (minutes < 60) return `${minutes} phút trước`
    return `${Math.max(1, Math.floor(minutes / 60))} giờ trước`
  }
  if (dayDiff === 1) return "Hôm qua"
  if (dayDiff < 7) return `${dayDiff} ngày trước`
  return date.toLocaleDateString("vi-VN")
}

function exactTime(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" })
}

function rowTime(iso: string) {
  const date = new Date(iso)
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  if (dayDiff <= 0) return relativeTime(iso)
  return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
}

function groupItems(items: NotificationItem[]) {
  const groups: { key: string; label: string; items: NotificationItem[] }[] = []
  for (const item of items) {
    const key = String(startOfDay(new Date(item.createdAt)))
    const last = groups.at(-1)
    if (last?.key === key) last.items.push(item)
    else groups.push({ key, label: dayLabel(item.createdAt), items: [item] })
  }
  return groups
}

export function NotificationsPage() {
  usePageMeta("Thông báo", "Cập nhật đơn sản phẩm, báo giá và tiến độ dự án của bạn.")
  const navigate = useNavigate()
  const client = useQueryClient()
  const [filter, setFilter] = useState<Filter>("all")
  const [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ["notifications", filter, page], queryFn: () => notificationClient.list({ page, limit: 10, unread: filter === "unread" }), refetchInterval: 60_000 })
  const refresh = () => void client.invalidateQueries({ queryKey: ["notifications"] })
  const read = useMutation({ mutationFn: (item: NotificationItem) => notificationClient.read(item._id), onSuccess: result => { refresh(); if (result.data.link) navigate(result.data.link) } })
  const readAll = useMutation({ mutationFn: notificationClient.readAll, onSuccess: refresh })
  const unread = query.data?.data.unread ?? 0
  const allTotal = query.data?.data.allTotal ?? 0
  const pages = query.data?.data.pages ?? 1
  const groups = useMemo(() => groupItems(query.data?.data.items ?? []), [query.data?.data.items])
  const actionError = read.error || readAll.error

  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])

  const changePage = (nextPage: number) => {
    setPage(nextPage)
    document.getElementById("notification-list")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return <div className="bg-stone-50 pb-20 pt-8 sm:pt-12">
    <div className="container-page">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[.22em] text-orange-700">Trung tâm cập nhật</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="page-title text-4xl text-emerald-950">Thông báo</h1>
            {unread > 0 && <span className="rounded-full bg-orange-600 px-2.5 py-1 text-xs font-black text-white">{unread} mới</span>}
          </div>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Báo giá, đơn hàng và tiến độ dự án được gom về một nơi.</p>
        </div>
      </header>

      <section id="notification-list" className="mt-6 scroll-mt-24 overflow-hidden rounded-card border border-slate-200 bg-white shadow-[0_18px_40px_-28px_rgb(2_44_34/0.45)]" aria-busy={query.isLoading}>
        <div className="h-1 bg-gradient-to-r from-emerald-800 via-emerald-600 to-orange-500" />
        <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="inline-flex w-fit rounded-full bg-stone-100 p-1" role="group" aria-label="Lọc thông báo">
            {([["all", "Tất cả", allTotal], ["unread", "Chưa đọc", unread]] as const).map(([id, label, count]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(1) }} className={cn("inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition", filter === id ? "bg-white text-emerald-950 shadow-sm" : "text-slate-500 hover:text-emerald-950")}>{label}{query.data && <span className={cn("text-xs tabular-nums", filter === id ? "text-emerald-700" : id === "unread" && count > 0 ? "text-orange-600" : "text-slate-400")}>{count}</span>}</button>)}
          </div>
          <Button variant="outline" size="sm" className="w-full bg-white sm:w-auto" disabled={!unread || readAll.isPending} onClick={() => readAll.mutate()}><CheckCheck className="size-4" />{readAll.isPending ? "Đang cập nhật..." : "Đánh dấu tất cả đã đọc"}</Button>
        </div>

        {query.isLoading && <SkeletonList />}
        {actionError && <p role="alert" className="m-4 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{actionError.message}</p>}
        {query.error && <p role="alert" className="m-4 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{query.error.message}</p>}

        {!query.isLoading && !query.error && groups.map(group => <div key={group.key}>
          <h2 className="bg-stone-50 px-5 py-2.5 text-xs font-bold text-slate-500">{group.label}</h2>
          <ul className="divide-y divide-slate-100">{group.items.map(item => <li key={item._id}><NotificationRow item={item} pending={read.isPending && read.variables?._id === item._id} onOpen={() => read.mutate(item)} /></li>)}</ul>
        </div>)}

        {!query.isLoading && !query.error && filter === "all" && allTotal === 0 && <EmptyState title="Bạn chưa có thông báo nào." detail="Khi có báo giá, đơn hàng hoặc cập nhật dự án, nội dung sẽ hiện tại đây." />}
        {!query.isLoading && !query.error && filter === "unread" && unread === 0 && <EmptyState title="Bạn đã đọc hết thông báo." detail="Bộ lọc đang chỉ các mục chưa đọc. Chuyển sang Tất cả để xem lại lịch sử." />}
        {!query.isLoading && !query.error && query.data && query.data.data.total > 0 && <div className="border-t border-slate-100 px-4 pb-4 sm:px-5"><Pagination page={query.data.data.page} pages={pages} onChange={changePage} /></div>}
      </section>
    </div>
  </div>
}

function NotificationRow({ item, pending, onOpen }: { item: NotificationItem; pending: boolean; onOpen: () => void }) {
  const kind = kindOf(item.type)
  const Icon = kind.icon
  const unread = !item.readAt
  return <button type="button" onClick={onOpen} disabled={pending} className={cn("group flex w-full items-start gap-3 px-4 py-4 text-left transition hover:bg-orange-50/50 disabled:opacity-60 sm:gap-4 sm:px-5", unread && "bg-emerald-50/35")}>
    <span className={cn("mt-0.5 grid size-11 shrink-0 place-items-center rounded-2xl", kind.tone)}><Icon className="size-5" aria-hidden="true" /></span>
    <span className="min-w-0 flex-1">
      <span className="flex items-start justify-between gap-3">
        <strong className={cn("font-display text-[15px] leading-6", unread ? "font-bold text-emerald-950" : "font-semibold text-slate-600")}>{item.title}</strong>
        <time className="hidden shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-slate-400 sm:block" dateTime={item.createdAt} title={exactTime(item.createdAt)}>{rowTime(item.createdAt)}</time>
      </span>
      <span className="mt-1 line-clamp-2 block text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">{item.message}</span>
      <span className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">{kind.label}</span>
        {unread && <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-orange-700"><span className="size-1.5 rounded-full bg-orange-500" aria-hidden="true" />Chưa đọc</span>}
        <time className="text-[11px] font-semibold tabular-nums text-slate-400 sm:hidden" dateTime={item.createdAt}>{rowTime(item.createdAt)}</time>
      </span>
    </span>
    <ChevronRight className="mt-3 size-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-orange-600" aria-hidden="true" />
  </button>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="px-6 py-16 text-center">
    <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-800"><Bell className="size-6" aria-hidden="true" /></span>
    <p className="mt-4 font-display text-lg font-bold text-emerald-950">{title}</p>
    <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-slate-500">{detail}</p>
  </div>
}

function SkeletonList() {
  return <div className="divide-y divide-slate-100" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index} className="flex gap-4 px-5 py-4"><span className="size-11 animate-pulse rounded-2xl bg-slate-100" /><span className="flex-1 space-y-2 py-1"><span className="block h-4 w-1/2 animate-pulse rounded bg-slate-100" /><span className="block h-3 w-full animate-pulse rounded bg-slate-100" /><span className="block h-3 w-4/5 animate-pulse rounded bg-slate-100" /></span></div>)}</div>
}
