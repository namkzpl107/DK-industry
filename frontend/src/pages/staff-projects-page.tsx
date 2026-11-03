import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Eye, FolderKanban, LoaderCircle, RefreshCw, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Pagination } from "@/components/pagination"
import { ProjectDetail } from "@/components/staff/project-detail"
import { StaffShell } from "@/components/staff/staff-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
import { usePageMeta } from "@/hooks/use-page-meta"
import { staffClient } from "@/lib/staff-client"
import { projectStageLabel } from "@/lib/project-progress"
import { cn } from "@/lib/utils"
import type { WorkOrderStatus } from "@/types/staff"

const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" })
const statusLabel = (status: WorkOrderStatus) => projectStageLabel(status)

export function StaffProjectsPage() {
  usePageMeta("Dự án", "Theo dõi các dự án gia công từ khi thống nhất báo giá đến khi hoàn thành.")
  const client = useQueryClient(); const toast = useToast(); const [params] = useSearchParams()
  const [filters, setFilters] = useState({ q: params.get("q") || "", view: params.get("view") === "completed" ? "completed" : "active", assigned: "" })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(params.get("workOrderId") || "")
  useEffect(() => { setSelected(params.get("workOrderId") || "") }, [params])
  const list = useQuery({ queryKey: ["staff", "work-orders", filters, page], queryFn: () => staffClient.workOrders({ ...filters, page }) })
  const detail = useQuery({ queryKey: ["staff", "work-order", selected], queryFn: () => staffClient.workOrder(selected), enabled: Boolean(selected) })
  useEffect(() => setPage(1), [filters])
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["staff", "work-orders"] }), client.invalidateQueries({ queryKey: ["staff", "work-order", selected] }), client.invalidateQueries({ queryKey: ["staff", "dashboard"] })])
  const update = useMutation({ mutationFn: (body: Parameters<typeof staffClient.updateWorkOrder>[1]) => staffClient.updateWorkOrder(selected, body), onSuccess: async result => { await refresh(); toast.success(result.message || "Đã cập nhật dự án") }, onError: error => toast.error(error.message) })
  const repair = useMutation({ mutationFn: (body: Parameters<typeof staffClient.decideRepair>[1]) => staffClient.decideRepair(selected, body), onSuccess: async result => { await refresh(); toast.success(result.message || "Đã xử lý yêu cầu sửa") }, onError: error => toast.error(error.message) })
  const items = list.data?.data.items || []

  return <StaffShell title="Dự án" description="Chốt ngày giao. Khách xác nhận nhận hàng thì dự án hoàn thành.">
    {selected ? <div className="space-y-5"><Button variant="outline" disabled={update.isPending || repair.isPending} onClick={() => setSelected("")}><ArrowLeft className="size-4"/>Quay lại danh sách dự án</Button>{detail.isLoading ? <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> : detail.data?.data ? <ProjectDetail item={detail.data.data} busy={update.isPending || repair.isPending} error={(update.error || repair.error) as Error | null} onUpdate={body => update.mutate(body)} onRepair={body => repair.mutate(body)}/> : <p className="rounded-2xl bg-white p-10 text-center text-slate-500">Không thể tải dự án.</p>}</div> : <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-emerald-950 px-5 py-5 text-white sm:px-6"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-orange-300 ring-1 ring-white/15"><FolderKanban className="size-5"/></span><div><h2 className="font-display text-xl font-bold">{filters.view === "completed" ? "Hoàn thành" : "Đang làm"}</h2><p className="mt-1 text-sm text-emerald-100/70">Chọn dự án để xem ngày giao và xử lý yêu cầu sửa.</p></div></div><div className="flex items-center gap-2"><span className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-emerald-950">{list.data?.data.total || 0} dự án</span><button type="button" onClick={() => void list.refetch()} className="grid size-10 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15 hover:bg-white/20" aria-label="Làm mới"><RefreshCw className={cn("size-4", list.isFetching && "animate-spin")}/></button></div></div>
      <div className="border-b p-4 sm:p-5"><nav className="mb-4 flex gap-2" aria-label="Nhóm dự án"><button type="button" onClick={() => setFilters({ ...filters, view: "active" })} className={cn("min-h-11 rounded-xl px-5 text-sm font-bold", filters.view === "active" ? "bg-emerald-950 text-white" : "bg-slate-100 text-slate-600")}>Đang làm</button><button type="button" onClick={() => setFilters({ ...filters, view: "completed" })} className={cn("min-h-11 rounded-xl px-5 text-sm font-bold", filters.view === "completed" ? "bg-emerald-950 text-white" : "bg-slate-100 text-slate-600")}>Hoàn thành</button></nav><label className="relative block max-w-xl"><Search className="absolute left-3 top-3.5 size-5 text-slate-400"/><Input className="pl-10" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} placeholder="Tìm theo mã dự án..."/></label></div>
      <div className="hidden grid-cols-[1.2fr_1fr_180px_160px_52px] gap-4 border-b bg-slate-50 px-5 py-3 text-xs font-black uppercase tracking-wider text-slate-500 lg:grid"><span>Dự án</span><span>Khách hàng</span><span>Tiến độ</span><span className="text-right">Giá trị</span><span/></div>
      <div className="max-h-[min(58vh,620px)] min-h-72 overflow-y-auto">{items.map(item => <button type="button" key={item._id} onClick={() => setSelected(item._id)} className={cn("group grid w-full grid-cols-[1fr_auto] items-center gap-3 border-b border-l-4 border-b-slate-100 border-l-orange-400 px-5 py-4 text-left last:border-b-0 hover:bg-orange-50/60 lg:grid-cols-[1.2fr_1fr_180px_160px_52px]", item.integrityIssues?.length && "border-l-red-500 bg-red-50/30")}><div className="min-w-0"><strong className="block truncate text-emerald-950">{item.request?.title || item.code}</strong><span className="mt-1 block text-xs font-bold text-slate-500">{item.code}</span></div><span className={cn("truncate text-sm font-semibold", item.customer ? "text-slate-700" : "text-red-700")}>{item.customer?.name || "Khách hàng không còn tồn tại"}</span><span className="w-fit rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-800">{statusLabel(item.status)}</span><strong className="text-orange-700 lg:text-right">{money.format(item.agreedTotal)}</strong><span className="grid size-9 place-items-center rounded-xl bg-orange-50 text-orange-600 group-hover:bg-orange-600 group-hover:text-white"><Eye className="size-4"/></span></button>)}{list.isLoading && <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div>}{list.error && <p role="alert" className="m-5 rounded-xl bg-red-50 p-4 text-red-700">{list.error.message}</p>}{!list.isLoading && !items.length && <p className="p-10 text-center text-slate-500">{filters.view === "active" ? "Chưa có dự án đang làm." : "Chưa có dự án hoàn thành."}</p>}</div>
      <div className="border-t px-4 py-3"><Pagination page={list.data?.data.page || page} pages={list.data?.data.pages || 1} onChange={setPage}/></div>
    </section>}
  </StaffShell>
}
