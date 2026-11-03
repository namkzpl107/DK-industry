import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ChevronRight, CircleDollarSign, FileCheck2, FolderKanban, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CustomerShell } from "@/components/customer/customer-shell"
import { ProjectProgress } from "@/components/project-progress"
import { projectHasStarted, projectStageLabel } from "@/lib/project-progress"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { usePageMeta } from "@/hooks/use-page-meta"
import { customerClient } from "@/lib/customer-client"
import { cn, formatPrice } from "@/lib/utils"
import type { WorkOrder } from "@/types/customer"

const statusLabel = (status: WorkOrder["status"]) => projectStageLabel(status)
const dateTime = (value?: string) => value ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Chưa cập nhật"

export function CustomerProjectsPage() {
  usePageMeta("Dự án của tôi", "Xem ngày giao, xác nhận nhận hàng hoặc yêu cầu sửa.")
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<"active" | "completed">(params.get("view") === "completed" ? "completed" : "active")
  const selectedId = params.get("projectId") || ""
  const projects = useQuery({ queryKey: ["customer", "projects"], queryFn: customerClient.projects, refetchInterval: 15_000, refetchOnWindowFocus: "always" })
  const selected = projects.data?.data.find(item => item._id === selectedId)
  const items = useMemo(() => (projects.data?.data || []).filter(item => tab === "completed" ? item.status === "completed" : !["completed", "cancelled"].includes(item.status)), [projects.data, tab])
  const selectProject = (id: string) => setParams({ projectId: id, view: tab })
  const changeTab = (value: "active" | "completed") => { setTab(value); setParams({ view: value }) }

  if (selectedId && !projects.isLoading && !selected) return <CustomerShell title="Dự án của tôi" description="Chi tiết dự án"><p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">{projects.error?.message || "Không tìm thấy dự án hoặc bạn không có quyền xem."}</p><Button className="mt-4" variant="outline" onClick={() => setParams({})}>Danh sách dự án</Button></CustomerShell>

  return <CustomerShell title="Dự án của tôi" description="Xem ngày giao. Đúng ngày nhận hàng thì bấm xác nhận. Hàng lỗi thì yêu cầu sửa.">
    {selected ? <ProjectDetail project={selected} onBack={() => setParams({ view: tab })}/> : <>
      <nav className="mb-5 flex w-fit gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm" aria-label="Lọc dự án">
        <button type="button" onClick={() => changeTab("active")} className={cn("min-h-11 rounded-xl px-5 text-sm font-bold", tab === "active" ? "bg-emerald-950 text-white" : "text-slate-600 hover:bg-slate-100")}>Đang triển khai</button>
        <button type="button" onClick={() => changeTab("completed")} className={cn("min-h-11 rounded-xl px-5 text-sm font-bold", tab === "completed" ? "bg-emerald-950 text-white" : "text-slate-600 hover:bg-slate-100")}>Đã hoàn thành</button>
      </nav>
      {projects.isLoading ? <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> : projects.error ? <p role="alert" className="rounded-2xl bg-red-50 p-5 font-semibold text-red-700">{projects.error.message}</p> : items.length ? <section className="overflow-hidden rounded-card border border-slate-200 bg-white "><div className="flex items-center justify-between bg-emerald-950 px-5 py-5 text-white sm:px-7"><div><p className="text-xs font-black uppercase tracking-[.18em] text-orange-300">Theo dõi sản xuất</p><h2 className="mt-1 font-display text-xl font-bold">{tab === "active" ? "Dự án đang triển khai" : "Dự án đã hoàn thành"}</h2></div><span className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-emerald-950">{items.length} dự án</span></div><div className="hidden grid-cols-[minmax(0,1.35fr)_minmax(150px,.65fr)_180px_160px_110px] gap-5 border-b border-slate-200 bg-slate-50/80 px-6 py-3 text-[11px] font-black uppercase tracking-[.12em] text-slate-500 lg:grid"><span>Dự án</span><span>Báo giá</span><span>Tiến độ</span><span className="text-right">Giá trị</span><span className="text-right">Thao tác</span></div>{items.map(item => <button type="button" key={item._id} onClick={() => selectProject(item._id)} className="group block w-full border-b border-slate-100 px-5 py-5 text-left transition last:border-b-0 hover:bg-orange-50/50 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(150px,.65fr)_180px_160px_110px] lg:items-center lg:gap-5 lg:px-6 lg:py-4"><div className="min-w-0"><span className="text-xs font-black uppercase tracking-wider text-orange-700">{item.code}</span><strong className="mt-1 block truncate text-base text-emerald-950">{item.request?.title || "Dự án gia công"}</strong><div className="mt-3 flex flex-wrap items-center gap-2 lg:hidden"><span className="text-xs text-slate-500">{item.quotation?.code || "Báo giá đã duyệt"}</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-800">{statusLabel(item.status)}</span></div></div><span className="hidden truncate text-sm font-semibold text-slate-600 lg:block">{item.quotation?.code || "Đã thống nhất"}</span><span className="hidden w-fit rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-800 lg:block">{statusLabel(item.status)}</span><strong className="hidden text-right text-orange-700 lg:block">{formatPrice(item.agreedTotal)}</strong><span className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-orange-50 px-3 text-sm font-bold text-orange-700 transition group-hover:bg-orange-600 group-hover:text-white lg:mt-0 lg:justify-self-end">Tiến độ<ChevronRight className="size-4"/></span></button>)}</section> : <div className="rounded-3xl border border-dashed border-slate-300 bg-white py-16 text-center"><FolderKanban className="mx-auto size-12 text-slate-300"/><p className="mt-4 font-bold text-slate-700">{tab === "active" ? "Chưa có dự án đang triển khai." : "Chưa có dự án hoàn thành."}</p><p className="mt-2 text-sm text-slate-500">Dự án được tạo tự động sau khi bạn đồng ý báo giá.</p></div>}
    </>}
  </CustomerShell>
}

function ProjectDetail({ project, onBack }: { project: WorkOrder; onBack: () => void }) {
  const client = useQueryClient(); const toast = useToast()
  const [reason, setReason] = useState(""); const [mode, setMode] = useState<"" | "request" | "requote">("")
  const refresh = () => client.invalidateQueries({ queryKey: ["customer", "projects"] })
  const receive = useMutation({ mutationFn: () => customerClient.receiveProject(project._id), onSuccess: result => { toast.success(result.message || "Đã xác nhận nhận hàng"); void refresh() }, onError: error => toast.error(error.message) })
  const repair = useMutation({ mutationFn: () => customerClient.requestRepair(project._id, { action: mode === "requote" ? "requote" : "request", reason: reason.trim() }), onSuccess: result => { toast.success(result.message || "Đã gửi yêu cầu sửa"); setMode(""); setReason(""); void refresh() }, onError: error => toast.error(error.message) })
  const busy = receive.isPending || repair.isPending
  const open = !["completed", "cancelled"].includes(project.status)
  const savedDelivery = project.deliveryDateSavedAt ? project.plannedDeliveryAt : undefined
  const now = useClock(savedDelivery)
  const started = projectHasStarted(project.status)
  const ready = started && savedDelivery ? vietnamDateKey(now) >= vietnamDateKey(savedDelivery) : false
  const deliveryLabel = savedDelivery ? new Date(savedDelivery).toLocaleDateString("vi-VN") : ""
  const lockMessage = !started ? "Xưởng chưa chuyển dự án sang đang triển khai. Nút nhận hàng mở sau bước đó và đúng ngày giao." : deliveryLabel ? `Nút nhận hàng mở vào ngày ${deliveryLabel}, theo đúng ngày giao xưởng đã lưu.` : "Xưởng chưa chốt ngày giao. Nút nhận hàng sẽ mở vào đúng ngày đó."
  return <article className="space-y-6">
    <Button variant="outline" onClick={onBack}><ArrowLeft className="size-4"/>Quay lại danh sách dự án</Button>
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-black uppercase tracking-wider text-orange-700">{project.code}</p><h2 className="mt-2 font-display text-3xl font-bold text-emerald-950">{project.request?.title || "Dự án gia công"}</h2><p className="mt-2 text-slate-600">Báo giá {project.quotation?.code || "đã thống nhất"}</p></div><span className={cn("rounded-full px-4 py-2 text-sm font-black", project.status === "cancelled" ? "bg-red-50 text-red-700" : project.status === "completed" ? "bg-emerald-50 text-emerald-800" : "bg-orange-50 text-orange-800")}>{statusLabel(project.status)}</span></div>
      <ProjectProgress status={project.status}/>
      <div className="mt-8 grid gap-4 rounded-2xl bg-slate-50 p-5 sm:grid-cols-3"><Info icon={CircleDollarSign} label="Giá trị đã chốt" value={formatPrice(project.agreedTotal)}/><Info icon={FileCheck2} label="Báo giá" value={project.quotation?.code || "Đã thống nhất"}/><Info icon={FileCheck2} label="Ngày giao" value={deliveryLabel || "Chưa hẹn"}/></div>
      {open && <div className="mt-5"><Button size="lg" disabled={busy || !ready} onClick={() => receive.mutate()}>Đã nhận hàng</Button>{!ready && <p className="mt-2 text-sm leading-6 text-slate-600">{lockMessage}</p>}</div>}
      {project.status === "completed" && project.repair?.status !== "requested" && project.repair?.status !== "requote" && <div className="mt-5">{mode ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); repair.mutate() }}><Textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder={mode === "requote" ? "Mô tả việc cần sửa và đồng ý tính phí" : "Mô tả lỗi cần sửa"}/><div className="flex gap-2"><Button disabled={busy || reason.trim().length < 5}>{mode === "requote" ? "Gửi yêu cầu sửa tính phí" : "Gửi yêu cầu sửa"}</Button><Button type="button" variant="ghost" onClick={() => setMode("")}>Quay lại</Button></div></form> : <div className="flex flex-wrap gap-2">{project.repair?.status === "rejected" ? <Button variant="outline" onClick={() => setMode("requote")}>Sửa tính phí</Button> : <Button variant="outline" onClick={() => setMode("request")}>Yêu cầu sửa</Button>}</div>}</div>}
      {project.repair?.status === "requested" && <p className="mt-5 rounded-2xl bg-orange-50 p-4 text-sm text-orange-900">Đã gửi yêu cầu sửa. Xưởng sẽ phản hồi qua email.</p>}
      {project.repair?.status === "accepted" && <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900">Xưởng đã nhận sửa{project.repair.resolution ? `: ${project.repair.resolution}` : "."}</p>}
      {(receive.error || repair.error) && <p className="mt-4 rounded-xl bg-red-50 p-4 text-red-700">{(receive.error || repair.error)?.message}</p>}
    </section>
    <section className="rounded-3xl border border-slate-200 bg-white p-6 sm:p-8"><h3 className="font-display text-2xl font-bold text-emerald-950">Nhật ký</h3><ol className="mt-5 space-y-4">{[...(project.timeline || [])].reverse().map((item, index) => <li className="flex gap-3" key={`${item.at}-${index}`}><span className="mt-2 size-2.5 shrink-0 rounded-full bg-orange-500"/><div><strong className="text-slate-800">{statusLabel(item.status as WorkOrder["status"])}</strong>{item.message && <p className="mt-1 leading-6 text-slate-600">{item.message}</p>}<time className="mt-1 block text-xs text-slate-400">{dateTime(item.at)}</time></div></li>)}{!project.timeline?.length && <li className="text-slate-500">Chưa có cập nhật.</li>}</ol></section>
  </article>
}

function Info({ icon: Icon, label, value }: { icon: typeof CircleDollarSign; label: string; value: string }) { return <div className="flex gap-3"><Icon className="mt-0.5 size-5 shrink-0 text-orange-600"/><p><span className="block text-xs font-bold uppercase tracking-wide text-slate-400">{label}</span><strong className="mt-1 block text-sm text-emerald-950">{value}</strong></p></div> }

const vietnamDateKey = (value: string | number | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))

function useClock(deliveryAt?: string) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const interval = window.setInterval(tick, 30_000)
    const onWake = () => tick()
    document.addEventListener("visibilitychange", onWake)
    window.addEventListener("focus", onWake)
    let timer = 0
    if (deliveryAt) {
      const unlockAt = new Date(`${vietnamDateKey(deliveryAt)}T00:00:00+07:00`).getTime()
      const delay = unlockAt - Date.now()
      if (delay > 0) timer = window.setTimeout(tick, Math.min(delay + 500, 2_147_483_647))
    }
    return () => { window.clearInterval(interval); window.clearTimeout(timer); document.removeEventListener("visibilitychange", onWake); window.removeEventListener("focus", onWake) }
  }, [deliveryAt])
  return now
}
