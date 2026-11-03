import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Archive, ArrowLeft, ArrowRight, Building2, CalendarDays, Check, CheckCheck, ChevronDown, Download, Eye, FileText, FolderKanban, Inbox, Info, ListChecks, LoaderCircle, LockKeyhole, Mail, MessageSquareText, Phone, Plus, RefreshCw, Search, Send, Sparkles, UserRound, Wifi, WifiOff } from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { StaffShell } from "@/components/staff/staff-shell"
import { Pagination } from "@/components/pagination"
import { Button } from "@/components/ui/button"
import { QuotationForm } from "@/components/staff/quotation-form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { useAuth } from "@/contexts/auth-context"
import { usePageMeta } from "@/hooks/use-page-meta"
import { useRequestRealtime } from "@/hooks/use-request-realtime"
import { requestStageLabel, requestStageStyle, unquotedStyle } from "@/lib/simple-status"
import { staffClient } from "@/lib/staff-client"
import { cn } from "@/lib/utils"
import type { RequestStatus, StaffLead, StaffMessage, StaffRequestDetail } from "@/types/staff"

const requestViews = [
  { value: "new", label: "Yêu cầu mới", description: "Chưa báo giá và chưa từ chối", icon: Inbox },
  { value: "waiting", label: "Chờ khách", description: "Đã gửi báo giá", icon: Mail },
  { value: "doing", label: "Đang làm", description: "Đã chốt, chưa nhận hàng", icon: FolderKanban },
  { value: "done", label: "Hoàn thành", description: "Đã nhận hàng hoặc không thực hiện", icon: Archive },
]
const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" })
type DetailResult = { success: boolean; data: StaffRequestDetail; message?: string }

function mergeMessage(messages: StaffMessage[], incoming: StaffMessage) {
  const values = messages.filter(item => item._id !== incoming._id && (!incoming.clientMessageId || item.clientMessageId !== incoming.clientMessageId))
  return [...values, incoming].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

export function StaffRequestsPage() {
  usePageMeta("Yêu cầu", "Mở hồ sơ, gửi báo giá hoặc từ chối ngay trong cùng một màn hình.")
  const [params, setParams] = useSearchParams(); const client = useQueryClient()
  const toast = useToast()
  const { user } = useAuth()
  const views = requestViews
  const [filters, setFilters] = useState({ q: params.get("q") || "", view: params.get("view") || "new" })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(params.get("requestId") || "")
  const [selectedLead, setSelectedLead] = useState(params.get("leadId") || "")
  useEffect(() => {
    setSelected(params.get("requestId") || "")
    setSelectedLead(params.get("leadId") || "")
  }, [params])
  const showLeads = filters.view === "new" || filters.view === "done"
  const list = useQuery({ queryKey: ["staff", "requests", filters, page], queryFn: () => staffClient.requests({ ...filters, page }) })
  const guestLeads = useQuery({ queryKey: ["staff", "leads", filters.view, filters.q], queryFn: () => staffClient.leads({ queue: filters.view === "done" ? "done" : "new", q: filters.q }), enabled: showLeads })
  const leadDetail = useQuery({ queryKey: ["staff", "lead", selectedLead], queryFn: () => staffClient.lead(selectedLead), enabled: Boolean(selectedLead) })
  const detail = useQuery({ queryKey: ["staff", "request", selected], queryFn: () => staffClient.request(selected), enabled: Boolean(selected) })
  useEffect(() => setPage(1), [filters])
  const detailKey = ["staff", "request", selected] as const
  const updateDetail = (updater: (value: StaffRequestDetail) => StaffRequestDetail) => client.setQueryData<DetailResult>(detailKey, current => current ? { ...current, data: updater(current.data) } : current)
  const refresh = () => { void client.invalidateQueries({ queryKey: ["staff", "requests"] }); void client.invalidateQueries({ queryKey: ["staff", "leads"] }); void client.invalidateQueries({ queryKey: detailKey }); void client.invalidateQueries({ queryKey: ["staff", "dashboard"] }) }
  const update = useMutation({ mutationFn: (body: Parameters<typeof staffClient.updateRequest>[1]) => staffClient.updateRequest(selected, body), onSuccess: result => { toast.success(result.message || "Đã cập nhật hồ sơ"); refresh() }, onError: error => toast.error(error.message) })
  const quoteLead = useMutation({ mutationFn: (body: Parameters<typeof staffClient.quoteLead>[1]) => staffClient.quoteLead(selectedLead, body), onSuccess: result => { toast.success(result.message || "Đã gửi báo giá"); setFilters(current => ({ ...current, view: "waiting" })); setSelectedLead(""); setSelected(result.data.requestId); setParams({ view: "waiting", requestId: result.data.requestId }); refresh() }, onError: error => toast.error(error.message, { title: "Không gửi được báo giá" }) })
  const rejectLead = useMutation({ mutationFn: (lostReason: string) => staffClient.updateLead(selectedLead, { status: "lost", lostReason, message: lostReason }), onSuccess: result => { toast.success(result.message || "Đã từ chối yêu cầu"); setSelectedLead(""); refresh() }, onError: error => toast.error(error.message) })
  const message = useMutation({
    mutationFn: (body: { content: string; visibility: "customer" | "internal"; clientMessageId: string }) => staffClient.sendMessage(selected, body.content, body.visibility, body.clientMessageId),
    onMutate: body => updateDetail(value => ({ ...value, messages: mergeMessage(value.messages, { _id: `pending:${body.clientMessageId}`, clientMessageId: body.clientMessageId, senderRole: "staff", visibility: body.visibility, content: body.content, attachments: [], createdAt: new Date().toISOString(), deliveryStatus: "sending" }) })),
    onSuccess: (result, variables) => { updateDetail(value => ({ ...value, messages: mergeMessage(value.messages.filter(item => item.clientMessageId !== variables.clientMessageId), result.data) })); toast.success(result.message || (variables.visibility === "internal" ? "Đã lưu ghi chú nội bộ" : "Đã gửi khách hàng")) },
    onError: (error, variables) => { updateDetail(value => ({ ...value, messages: value.messages.map(item => item.clientMessageId === variables.clientMessageId ? { ...item, deliveryStatus: "failed" } : item) })); toast.error(error.message) },
  })
  const quotation = useMutation({ mutationFn: (body: Parameters<typeof staffClient.createQuotation>[1]) => staffClient.createQuotation(selected, body), onSuccess: result => { toast.success(result.message || "Đã lưu báo giá"); refresh() }, onError: error => toast.error(error.message) })
  const sendQuote = useMutation({ mutationFn: (id: string) => staffClient.sendQuotation(selected, id), onSuccess: result => { toast.success(result.message || "Đã gửi báo giá"); refresh(); window.scrollTo({ top: 0, behavior: "smooth" }) }, onError: error => toast.error(error.message) })
  const realtime = useRequestRealtime(selected, Boolean(selected), {
    onMessage: incoming => updateDetail(value => ({ ...value, messages: mergeMessage(value.messages, incoming as unknown as StaffMessage) })),
    onRequestUpdated: refresh,
    onRead: (role, readAt) => updateDetail(value => ({ ...value, messages: value.messages.map(item => role === "customer" && item.senderRole !== "customer" && item.visibility === "customer" ? { ...item, readByCustomerAt: readAt } : item) })),
    onSync: refresh,
    onInboxUpdated: requestId => { void client.invalidateQueries({ queryKey: ["staff", "requests"] }); void client.invalidateQueries({ queryKey: ["staff", "dashboard"] }); if (requestId === selected) void client.invalidateQueries({ queryKey: detailKey }) },
  })
  const loadOlder = async () => {
    const page = detail.data?.data.messagePage
    if (!selected || !page?.hasMore) return
    const result = await staffClient.requestMessages(selected, page.nextCursor)
    updateDetail(value => ({ ...value, messages: [...result.data.items, ...value.messages].filter((item, index, all) => all.findIndex(candidate => candidate._id === item._id) === index), messagePage: { hasMore: result.data.hasMore, nextCursor: result.data.nextCursor } }))
  }
  const items = list.data?.data.items || []
  const guestItems = showLeads ? guestLeads.data?.data.items || [] : []
  const rows = [
    ...guestItems.map(lead => ({ kind: "lead" as const, at: lead.createdAt, lead })),
    ...items.map(request => ({ kind: "request" as const, at: request.createdAt, request })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  const guestTotal = showLeads ? guestLeads.data?.data.total || 0 : 0
  const visibleTotal = (list.data?.data.total || 0) + guestTotal
  const busy = update.isPending || message.isPending || quotation.isPending || sendQuote.isPending || quoteLead.isPending || rejectLead.isPending
  const changeView = (view: string) => { setFilters(current => ({ ...current, view })); setSelected(""); setSelectedLead(""); setParams({ view }) }
  const openRequest = (requestId: string) => { setSelectedLead(""); setSelected(requestId); setParams({ view: filters.view, requestId }) }
  const openLead = (leadId: string) => { setSelected(""); setSelectedLead(leadId); setParams({ view: filters.view, leadId }) }
  const closeRequest = () => { setSelected(""); setSelectedLead(""); setParams({ view: filters.view }) }
  return <StaffShell title="Yêu cầu" description="Mở hồ sơ, gửi báo giá hoặc từ chối ngay tại đây.">
    {selectedLead ? <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><Button variant="ghost" disabled={busy} onClick={closeRequest}><ArrowLeft className="size-4"/>Danh sách yêu cầu</Button></div>
      {leadDetail.isLoading ? <div className="grid min-h-96 place-items-center rounded-card border border-slate-200 bg-white"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> : leadDetail.data?.data ? <LeadQuotePanel lead={leadDetail.data.data} busy={busy} error={(quoteLead.error || rejectLead.error) as Error | null} onQuote={body => quoteLead.mutate(body)} onReject={reason => rejectLead.mutate(reason)}/> : <p className="rounded-2xl bg-white p-10 text-center text-slate-500">Không thể tải yêu cầu website.</p>}
    </div> : selected ? <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"><Button variant="ghost" disabled={busy} onClick={closeRequest}><ArrowLeft className="size-4"/>Danh sách yêu cầu</Button><span className="hidden items-center gap-2 text-sm font-semibold text-slate-500 sm:flex"><Sparkles className="size-4 text-orange-500"/>Tập trung vào một hồ sơ tại một thời điểm</span></div>
      {detail.isLoading ? <div className="grid min-h-96 place-items-center rounded-card border border-slate-200 bg-white"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> : detail.data?.data ? <RequestDetail detail={detail.data.data} currentUserId={user?.id || ""} busy={busy} error={(update.error || message.error || quotation.error || sendQuote.error) as Error | null} connected={realtime.connected} typingName={realtime.typingName} onTyping={realtime.setTyping} onLoadOlder={() => void loadOlder()} onUpdate={body => update.mutate(body)} onMessage={body => message.mutate({ ...body, clientMessageId: crypto.randomUUID() })} onQuotation={(body, onSuccess) => quotation.mutate(body, { onSuccess })} onSendQuote={id => sendQuote.mutate(id)}/> : <p className="rounded-2xl bg-white p-10 text-center text-slate-500">Không thể tải hồ sơ.</p>}
    </div> : <div className="space-y-5">
      <section className="relative overflow-hidden rounded-card bg-emerald-950 p-5 text-white shadow-[0_24px_60px_-32px_rgba(2,44,34,.8)] sm:p-7">
        
        <div className="relative flex flex-wrap items-start justify-between gap-5"><div className="flex items-start gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/10 text-orange-300 ring-1 ring-white/15"><ListChecks className="size-6"/></span><div><p className="text-xs font-black uppercase tracking-[.2em] text-orange-300">Hàng đợi xử lý</p><h2 className="mt-1 font-display text-2xl font-bold">Một danh sách, mở hồ sơ là làm được</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50/70">Yêu cầu website và yêu cầu đã đăng nhập nằm chung. Mở hồ sơ để báo giá hoặc từ chối, không cần chuyển trang.</p></div></div><div className="flex items-center gap-2"><span className="rounded-full bg-orange-400 px-3.5 py-2 text-xs font-black text-emerald-950">{visibleTotal} hồ sơ</span><button type="button" onClick={() => { void list.refetch(); void guestLeads.refetch() }} className="grid size-10 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15 transition hover:bg-white/20" aria-label="Làm mới danh sách"><RefreshCw className={cn("size-4", list.isFetching && "animate-spin")}/></button></div></div>
        <nav className="relative mt-6 grid gap-2 md:grid-cols-2 xl:grid-cols-4" aria-label="Nhóm yêu cầu">{views.map(({ value, label, description, icon: Icon }) => { const active = filters.view === value; return <button type="button" key={value} onClick={() => changeView(value)} className={cn("flex min-h-20 items-center gap-3 rounded-2xl px-4 text-left transition", active ? "bg-white text-emerald-950" : "bg-white/5 text-white ring-1 ring-white/10 hover:bg-white/10")}><span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", active ? "bg-orange-50 text-orange-600" : "bg-white/10 text-orange-300")}><Icon className="size-5"/></span><span><strong className="block text-sm">{label}</strong><span className={cn("mt-1 block text-xs", active ? "text-slate-500" : "text-emerald-50/60")}>{description}</span></span></button> })}</nav>
      </section>

      <section className="overflow-hidden rounded-card border border-slate-200 bg-white ">
        <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between"><div><h3 className="font-display text-xl font-bold text-emerald-950">{views.find(item => item.value === filters.view)?.label}</h3><p className="mt-1 text-sm text-slate-500">{views.find(item => item.value === filters.view)?.description}</p></div><label className="relative block w-full lg:max-w-md"><Search className="absolute left-3.5 top-3.5 size-5 text-slate-400"/><Input className="border-slate-200 bg-slate-50 pl-11" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} placeholder="Tìm mã yêu cầu, nội dung hoặc khách hàng"/></label></div>
        <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(180px,.75fr)_140px_200px_150px] gap-5 border-b border-slate-200 bg-slate-50/80 px-6 py-3 text-[11px] font-black uppercase tracking-[.12em] text-slate-500 lg:grid"><span>Hồ sơ yêu cầu</span><span>Khách hàng</span><span>Ngày gửi</span><span>Trạng thái hiện tại</span><span className="text-right">Thao tác</span></div>
        <div className="min-h-72">{rows.map(row => row.kind === "lead" ? (() => { const item = row.lead; return <button type="button" key={item._id} onClick={() => openLead(item._id)} className="group relative block w-full border-b border-slate-100 px-5 py-5 text-left transition hover:bg-orange-50/40 lg:grid lg:grid-cols-[minmax(0,1.4fr)_minmax(180px,.75fr)_140px_200px_120px] lg:items-center lg:gap-5 lg:px-6 lg:py-4"><span className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-orange-500"/><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono text-xs font-black uppercase tracking-wider text-orange-700">{item.code}</span><span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-black text-orange-700">WEBSITE</span></div><strong className="mt-1.5 block truncate text-base text-emerald-950 transition group-hover:text-orange-700">{item.serviceType || "Yêu cầu báo giá"}</strong><p className="mt-1 line-clamp-1 text-sm text-slate-500">{item.message || "Khách gửi từ form nhận báo giá."}</p></div><div className="hidden min-w-0 lg:block"><span className="block truncate text-sm font-bold text-slate-700">{item.name}</span><span className="mt-1 block truncate text-xs text-slate-400">{item.email || item.phone}</span></div><span className="hidden items-center gap-2 text-sm text-slate-500 lg:flex"><CalendarDays className="size-4 text-slate-400"/>{new Date(item.createdAt).toLocaleDateString("vi-VN")}</span><div className="hidden lg:block"><span className={cn("w-fit rounded-full px-3 py-1.5 text-xs font-black ring-1 ring-inset", filters.view === "done" ? "bg-slate-100 text-slate-600 ring-slate-200" : unquotedStyle)}>{filters.view === "done" ? "Không thực hiện" : "Chưa báo giá"}</span></div><span className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-slate-100 px-3.5 text-sm font-bold text-slate-700 transition group-hover:bg-orange-600 group-hover:text-white lg:mt-0 lg:justify-self-end">Xem hồ sơ<ArrowRight className="size-4"/></span></button> })() : (() => { const item = row.request; return <button type="button" key={item._id} onClick={() => openRequest(item._id)} className="group relative block w-full border-b border-slate-100 px-5 py-5 text-left transition last:border-b-0 hover:bg-orange-50/40 lg:grid lg:grid-cols-[minmax(0,1.4fr)_minmax(180px,.75fr)_140px_200px_120px] lg:items-center lg:gap-5 lg:px-6 lg:py-4"><span className={cn("absolute inset-y-3 left-0 w-1 rounded-r-full", item.revisionRequested ? "bg-rose-500" : item.status === "submitted" ? "bg-amber-500" : item.status === "reviewing" || item.status === "need_more_info" ? "bg-sky-500" : item.status === "accepted" ? "bg-emerald-500" : "bg-slate-200")}/><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono text-xs font-black uppercase tracking-wider text-orange-700">{item.code}</span>{Boolean(item.unreadCount) && <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-black text-white">{item.unreadCount} MỚI</span>}</div><strong className="mt-1.5 block truncate text-base text-emerald-950 transition group-hover:text-orange-700">{item.title}</strong><div className="mt-3 flex flex-wrap items-center gap-2 lg:hidden"><span className="text-sm font-semibold text-slate-600">{item.customer.name}</span><span className="text-slate-300">•</span><span className="text-xs text-slate-500">{new Date(item.createdAt).toLocaleDateString("vi-VN")}</span><span className={cn("rounded-full px-2.5 py-1 text-xs font-black ring-1 ring-inset", requestStageStyle(item.status, Boolean(item.revisionRequested)))}>{requestStageLabel(item.status, Boolean(item.revisionRequested))}</span></div></div><div className="hidden min-w-0 lg:block"><span className="block truncate text-sm font-bold text-slate-700">{item.customer.name}</span><span className="mt-1 block truncate text-xs text-slate-400">{item.customer.company || item.customer.email}</span></div><span className="hidden items-center gap-2 text-sm text-slate-500 lg:flex"><CalendarDays className="size-4 text-slate-400"/>{new Date(item.createdAt).toLocaleDateString("vi-VN")}</span><div className="hidden flex-wrap items-center gap-2 lg:flex"><span className={cn("w-fit rounded-full px-3 py-1.5 text-xs font-black ring-1 ring-inset", requestStageStyle(item.status, Boolean(item.revisionRequested)))}>{requestStageLabel(item.status, Boolean(item.revisionRequested))}</span></div><span className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-slate-100 px-3.5 text-sm font-bold text-slate-700 transition group-hover:bg-orange-600 group-hover:text-white lg:mt-0 lg:justify-self-end">Xem hồ sơ<ArrowRight className="size-4"/></span></button> })())}{list.isLoading && <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div>}{list.error && <p role="alert" className="m-5 rounded-xl bg-red-50 p-4 text-red-700">{list.error.message}</p>}{!list.isLoading && !guestLeads.isFetching && !items.length && !guestItems.length && <div className="grid min-h-72 place-items-center px-6 text-center"><div><span className="mx-auto grid size-16 place-items-center rounded-3xl bg-slate-100 text-slate-400"><Check className="size-7"/></span><p className="mt-4 font-bold text-slate-700">{filters.view === "new" ? "Không còn yêu cầu mới." : filters.view === "waiting" ? "Chưa có báo giá nào đang chờ khách." : filters.view === "doing" ? "Chưa có việc đang làm." : "Chưa có hồ sơ hoàn thành."}</p><p className="mt-1 text-sm text-slate-400">Danh sách sẽ tự cập nhật khi có thay đổi.</p></div></div>}</div>
        <div className="border-t border-slate-100 px-4 py-3"><Pagination page={list.data?.data.page || page} pages={list.data?.data.pages || 1} onChange={setPage}/></div>
      </section>
    </div>}
  </StaffShell>
}

function RequestDetail({ detail, currentUserId, busy, error, connected, typingName, onTyping, onLoadOlder, onUpdate, onMessage, onQuotation, onSendQuote }: { detail: StaffRequestDetail; currentUserId: string; busy: boolean; error: Error | null; connected: boolean; typingName: string; onTyping: (value: boolean) => void; onLoadOlder: () => void; onUpdate: (body: Parameters<typeof staffClient.updateRequest>[1]) => void; onMessage: (body: { content: string; visibility: "customer" | "internal" }) => void; onQuotation: (body: Parameters<typeof staffClient.createQuotation>[1], onSuccess: () => void) => void; onSendQuote: (id: string) => void }) {
  const { request, messages, quotations, workOrder } = detail
  const [params] = useSearchParams()
  const chatRequested = params.get("tab") === "chat"
  const latestQuotation = quotations[0]
  const [stopAction, setStopAction] = useState<"rejected" | "cancelled" | "">("")
  const [stopReason, setStopReason] = useState("")
  const [content, setContent] = useState("")
  const [visibility, setVisibility] = useState<"customer" | "internal">("customer")
  const [chatOpen, setChatOpen] = useState(() => chatRequested || window.localStorage.getItem("dk-staff-chat-open") === "1")
  useEffect(() => {
    if (chatRequested) {
      setChatOpen(true)
      document.getElementById("request-chat")?.scrollIntoView({ block: "start" })
    }
  }, [chatRequested, request._id])
  useEffect(() => { window.localStorage.setItem("dk-staff-chat-open", chatOpen ? "1" : "0") }, [chatOpen])
  useEffect(() => { setStopAction(""); setStopReason(""); setContent("") }, [request._id, request.status])
  const isOwner = !request.assignedTo || request.assignedTo._id === currentUserId
  const isOpen = !["accepted", "rejected", "cancelled"].includes(request.status)
  const canReject = ["submitted", "reviewing", "need_more_info"].includes(request.status)
  const canCancel = ["submitted", "reviewing", "need_more_info", "quoted"].includes(request.status)
  const download = async (attachmentId: string, filename: string, messageId?: string) => { const blob = messageId ? await staffClient.downloadMessageAttachment(request._id, messageId, attachmentId) : await staffClient.downloadAttachment(request._id, attachmentId); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url) }

  return <article className="space-y-6">
    <section className="relative overflow-hidden rounded-card bg-emerald-950 p-5 text-white shadow-[0_24px_60px_-34px_rgba(2,44,34,.85)] sm:p-8">
      
      <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-start"><div><div className="flex flex-wrap items-center gap-2"><p className="font-mono text-sm font-black uppercase tracking-wider text-orange-300">{request.code}</p><span className={cn("rounded-full px-3 py-1 text-xs font-black ring-1 ring-inset", requestStageStyle(request.status, request.status === "reviewing" && latestQuotation?.status === "rejected"))}>{requestStageLabel(request.status, request.status === "reviewing" && latestQuotation?.status === "rejected")}</span></div><h2 className="mt-3 max-w-4xl font-display text-3xl font-bold leading-tight text-white sm:text-4xl">{request.title}</h2><div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-emerald-50/75"><span className="flex items-center gap-1.5"><UserRound className="size-4 text-orange-300"/>{request.customer.name}</span>{request.customer.company && <span className="flex items-center gap-1.5"><Building2 className="size-4 text-orange-300"/>{request.customer.company}</span>}{request.customer.phone && <a className="flex items-center gap-1.5 underline-offset-2 hover:underline" href={`tel:${request.customer.phone}`}><Phone className="size-4 text-orange-300"/>{request.customer.phone}</a>}<span className="flex items-center gap-1.5"><CalendarDays className="size-4 text-orange-300"/>{new Date(request.createdAt).toLocaleString("vi-VN")}</span></div></div><div className="rounded-2xl bg-white/10 px-4 py-3 text-sm ring-1 ring-white/15"><span className="block text-xs font-bold uppercase tracking-wider text-emerald-100/60">Nhân viên trên hồ sơ</span><strong className="mt-1 block text-white">{request.assignedTo?.name || "Chưa ghi"}</strong></div></div>
      {error && <p className="relative mt-4 rounded-2xl bg-red-50 p-4 font-semibold text-red-700">{error.message}</p>}
    </section>

    <section className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,.7fr)]">
      <article className="rounded-card border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div><p className="text-xs font-black uppercase tracking-[.16em] text-orange-700">Thông tin khách đã gửi</p><h3 className="mt-1 font-display text-2xl font-bold text-emerald-950">Nội dung yêu cầu</h3></div><p className="mt-5 whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 leading-7 text-slate-700">{request.description}</p><dl className="mt-5 grid gap-3 sm:grid-cols-2">{[["Vật liệu", request.material], ["Số lượng", request.quantity], ["Kích thước / dung sai", request.dimensions], ["Ngân sách dự kiến", request.budget]].filter(([, value]) => value && value !== "-").map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-100 p-4"><dt className="text-[11px] font-black uppercase tracking-wider text-slate-400">{label}</dt><dd className="mt-1 font-bold text-emerald-950">{value}</dd></div>)}</dl><div className="mt-6 border-t border-slate-100 pt-5"><h4 className="font-bold text-emerald-950">Tài liệu đính kèm</h4>{request.attachments.length ? <div className="mt-3 flex flex-wrap gap-2">{request.attachments.map(file => <Button key={file._id} variant="outline" size="sm" onClick={() => download(file._id, file.originalName)}><Download className="size-4"/>{file.originalName}</Button>)}</div> : <p className="mt-2 text-sm text-slate-500">Khách hàng không gửi tệp đính kèm.</p>}</div></article>
      <div className="space-y-5"><article className="rounded-card border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="text-xs font-black uppercase tracking-[.16em] text-orange-700">Khách hàng</p><h3 className="mt-1 font-display text-xl font-bold text-emerald-950">Thông tin liên hệ</h3><div className="mt-5 space-y-4 text-sm"><p className="flex gap-3"><UserRound className="size-5 shrink-0 text-orange-600"/><span><strong className="block text-slate-800">{request.customer.name}</strong><span className="text-slate-500">{request.customer.email}</span></span></p>{request.customer.phone && <p className="flex gap-3"><Phone className="size-5 shrink-0 text-orange-600"/><span className="text-slate-700">{request.customer.phone}</span></p>}{request.customer.company && <p className="flex gap-3"><Building2 className="size-5 shrink-0 text-orange-600"/><span className="text-slate-700">{request.customer.company}</span></p>}</div></article>
        <article className="rounded-card border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="text-xs font-black uppercase tracking-[.16em] text-orange-700">Hành động</p><h3 className="mt-1 font-display text-xl font-bold text-emerald-950">Xử lý hồ sơ</h3>{!isOwner ? <p className="mt-5 rounded-2xl bg-slate-100 p-4 text-sm leading-6 text-slate-600">Hồ sơ do <strong>{request.assignedTo?.name || "nhân viên khác"}</strong> gửi báo giá. Bạn có thể xem.</p> : request.status === "rejected" ? <div className="mt-5"><p className="rounded-2xl bg-slate-100 p-4 text-sm leading-6 text-slate-600">Hồ sơ đang ở trạng thái không thực hiện. Mở lại nếu xưởng vẫn làm được.</p><Button className="mt-4 w-full" disabled={busy} onClick={() => onUpdate({ status: "reviewing", message: "Đã mở lại hồ sơ để tiếp tục báo giá.", visibility: "customer" })}>Mở lại hồ sơ</Button></div> : isOwner && (canReject || canCancel) ? <div className="mt-5 space-y-3">{stopAction ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); onUpdate({ status: stopAction, message: stopReason.trim(), visibility: "customer" }) }}><Textarea rows={3} value={stopReason} onChange={event => setStopReason(event.target.value)} placeholder={stopAction === "rejected" ? "Lý do không nhận việc, gửi cho khách" : "Lý do hủy hồ sơ, gửi cho khách"}/><div className="flex gap-2"><Button className="flex-1" disabled={busy || stopReason.trim().length < 3}>{stopAction === "rejected" ? "Xác nhận không nhận" : "Xác nhận hủy"}</Button><Button type="button" variant="ghost" onClick={() => { setStopAction(""); setStopReason("") }}>Quay lại</Button></div></form> : <div className="flex flex-col gap-2">{canReject && <Button variant="outline" onClick={() => setStopAction("rejected")}>Không nhận việc</Button>}{canCancel && <Button variant="ghost" onClick={() => setStopAction("cancelled")}>Hủy hồ sơ</Button>}</div>}</div> : <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">{request.status === "accepted" ? "Khách đã chốt. Theo dõi ở dự án bên dưới." : "Hồ sơ đã kết thúc."}</p>}</article></div>
    </section>

    <section id="request-chat" className="scroll-mt-24 overflow-hidden rounded-card border border-slate-200 bg-white shadow-[0_18px_50px_-34px_rgba(15,23,42,.3)]">
      <div className={cn("flex flex-wrap items-center justify-between gap-3 bg-slate-50/80 px-5 py-5 sm:px-7", chatOpen && "border-b border-slate-200")}>
        <div><h3 className="flex items-center gap-2 font-display text-2xl font-bold text-emerald-950"><MessageSquareText className="size-6 text-orange-600"/>Trao đổi với khách hàng</h3><p className="mt-1 text-sm text-slate-500">{chatOpen ? "Tin nhắn và ghi chú nội bộ được tách biệt rõ ràng." : `${messages.length} tin nhắn. Mở khi cần xem hoặc nhắn trên hệ thống.`}</p></div>
        <div className="flex flex-wrap items-center gap-2">{chatOpen && <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold", connected ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{connected ? <Wifi className="size-4"/> : <WifiOff className="size-4"/>}{connected ? "Trực tuyến" : "Đang kết nối"}</span>}<Button type="button" variant="outline" size="sm" aria-expanded={chatOpen} onClick={() => setChatOpen(open => !open)}>{chatOpen ? "Ẩn trao đổi" : "Hiện trao đổi"}<ChevronDown className={cn("size-4 transition", chatOpen && "rotate-180")}/></Button></div>
      </div>
      {chatOpen && <div className="p-5 sm:p-7">
      <div className="mt-5 max-h-[32rem] space-y-3 overflow-y-auto rounded-2xl border bg-slate-50 p-4">{detail.messagePage?.hasMore && <div className="text-center"><Button type="button" size="sm" variant="ghost" onClick={onLoadOlder}><LoaderCircle className="size-4"/>Tải tin nhắn cũ</Button></div>}{messages.map((item, index) => <div key={item._id} className={cn("rounded-2xl p-4", item.visibility === "internal" ? "border border-amber-200 bg-amber-50" : item.senderRole === "customer" ? "bg-white" : "bg-emerald-50", item.deliveryStatus === "failed" && "ring-2 ring-red-300")}><div className="flex justify-between gap-3 text-xs font-bold text-slate-500"><span>{item.visibility === "internal" ? "Ghi chú nội bộ · khách không thấy" : item.senderRole === "customer" ? request.customer.name : item.sender?.name || "Nhân viên"}</span><span>{new Date(item.createdAt).toLocaleString("vi-VN")}</span></div><p className="mt-2 whitespace-pre-wrap text-slate-800">{item.content}</p>{item.attachments.map(file => <button key={file._id} onClick={() => download(file._id, file.originalName, item._id)} className="mt-2 flex items-center gap-2 font-bold text-orange-700"><Download className="size-4"/>{file.originalName}</button>)}{item.senderRole !== "customer" && item.visibility === "customer" && !messages.slice(index + 1).some(next => next.senderRole !== "customer" && next.visibility === "customer") && <span className="mt-2 flex items-center justify-end gap-1 text-xs text-emerald-700">{item.deliveryStatus === "sending" ? "Đang gửi" : item.deliveryStatus === "failed" ? "Gửi lỗi" : item.readByCustomerAt ? <><CheckCheck className="size-4"/>Khách đã xem</> : <><Check className="size-4"/>Đã gửi khách</>}</span>}</div>)}{!messages.length && <p className="py-8 text-center text-sm text-slate-500">Chưa có trao đổi nào.</p>}</div>
      <div className="h-6 pt-1 text-xs font-semibold text-slate-500">{typingName && `${typingName} đang nhập...`}</div>
      {isOwner && isOpen && <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (content.trim()) { onMessage({ content: content.trim(), visibility }); setContent(""); onTyping(false) } }}>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant={visibility === "customer" ? "default" : "outline"} onClick={() => setVisibility("customer")}><Mail className="size-4"/>Gửi khách hàng</Button><Button type="button" size="sm" variant={visibility === "internal" ? "default" : "outline"} onClick={() => setVisibility("internal")}><LockKeyhole className="size-4"/>Ghi chú nội bộ</Button></div>
        <div className={cn("rounded-2xl border p-3 text-sm", visibility === "customer" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900")}>{visibility === "customer" ? `Nội dung sẽ gửi cho ${request.customer.name} qua cổng khách hàng và thông báo email ${request.customer.email}.` : "Nội dung chỉ nhân viên và quản trị viên nhìn thấy; khách hàng không nhận được."}</div>
        <Textarea rows={4} value={content} onChange={event => { setContent(event.target.value); onTyping(Boolean(event.target.value.trim())) }} onBlur={() => onTyping(false)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={visibility === "customer" ? "Nhập nội dung gửi khách hàng..." : "Nhập ghi chú nội bộ..."}/>
        <div className="flex justify-end"><Button disabled={busy || !content.trim()}><Send className="size-4"/>{visibility === "customer" ? `Gửi cho ${request.customer.name}` : "Lưu ghi chú nội bộ"}</Button></div>
      </form>}
      </div>}
    </section>

    <div className="space-y-5">{request.status === "reviewing" && latestQuotation?.status === "rejected" && <section className="rounded-card border border-orange-200 bg-gradient-to-r from-orange-50 to-white p-5"><div className="flex items-start gap-3"><span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-orange-100 text-orange-700"><AlertTriangle className="size-5"/></span><div><p className="font-display text-lg font-bold text-orange-950">Khách nhờ báo giá lại</p><p className="mt-1 text-sm leading-6 text-orange-900">{latestQuotation.responseNote || "Khách chưa ghi rõ nội dung cần điều chỉnh."}</p></div></div></section>}<QuotationPanel customerName={request.customer.name} customerEmail={request.customer.email} customerCompany={request.customer.company || request.contact?.company || ""} customerPhone={request.customer.phone || request.contact?.phone || ""} requestTitle={request.title} quotations={quotations} requestStatus={request.status} canEdit={isOwner} busy={busy} onCreate={onQuotation} onSend={onSendQuote}/></div>

    {request.status === "accepted" && <section className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-sm"><header className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 via-white to-white px-5 py-5 sm:px-7"><span className="grid size-11 place-items-center rounded-2xl bg-emerald-900 text-white"><FolderKanban className="size-5"/></span><div><h3 className="font-display text-xl font-bold text-emerald-950">Thỏa thuận & dự án</h3><p className="mt-0.5 text-sm text-slate-500">Kết quả sau khi công ty và khách hàng thống nhất báo giá.</p></div></header><div className="p-5 sm:p-7">{request.status === "accepted" && workOrder ? <div className="grid gap-5 rounded-card border border-emerald-200 bg-emerald-50 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-6"><div><span className="inline-flex rounded-full bg-emerald-900 px-3 py-1 text-xs font-black text-white">Đã thống nhất</span><h4 className="mt-3 font-display text-2xl font-bold text-emerald-950">Dự án {workOrder.code}</h4><p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-800">Báo giá đã được hai bên chấp thuận. Không cần nhập lại một biểu mẫu hợp đồng trùng lặp; bước tiếp theo là theo dõi quá trình thực hiện dự án.</p></div><Button type="button" onClick={() => window.location.assign(`/staff/work-orders?workOrderId=${workOrder._id}&q=${encodeURIComponent(workOrder.code)}`)}>Mở dự án {workOrder.code}<ArrowRight className="size-4"/></Button></div> : <div className="grid min-h-60 place-items-center px-5 text-center"><div><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><FolderKanban className="size-6"/></span><strong className="mt-4 block text-emerald-950">Chưa có thỏa thuận</strong><p className="mt-1 max-w-md text-sm leading-6 text-slate-500">Khu vực này sẽ hiển thị dự án sau khi khách hàng đồng ý báo giá.</p></div></div>}</div></section>}
  </article>
}

const quotationStatusNames: Record<string, string> = { draft: "Bản nháp", sent: "Chờ xác nhận", accepted: "Đã chốt", rejected: "Nhờ sửa", superseded: "Bản cũ", expired: "Hết hiệu lực" }

function QuotationPanel({ customerName, customerEmail, customerCompany, customerPhone, requestTitle, quotations, requestStatus, canEdit, busy, onCreate, onSend }: { customerName: string; customerEmail: string; customerCompany: string; customerPhone: string; requestTitle: string; quotations: StaffRequestDetail["quotations"]; requestStatus: RequestStatus; canEdit: boolean; busy: boolean; onCreate: (body: Parameters<typeof staffClient.createQuotation>[1], onSuccess: () => void) => void; onSend: (id: string) => void }) {
  const shouldRevise = requestStatus === "reviewing" && quotations[0]?.status === "rejected"
  const latestQuotationId = quotations[0]?._id
  const canCreate = canEdit && ["submitted", "reviewing", "need_more_info"].includes(requestStatus)
  const [open, setOpen] = useState(canCreate && (shouldRevise || quotations.length === 0))
  const [formKey, setFormKey] = useState(0)
  useEffect(() => { if (shouldRevise) setOpen(true) }, [shouldRevise, latestQuotationId])
  const [params] = useSearchParams()
  const [expandedQuote, setExpandedQuote] = useState(params.get("quotationId") || "")
  useEffect(() => { setExpandedQuote(params.get("quotationId") || "") }, [params])
  const previous = shouldRevise ? quotations[0] : undefined
  const resetForm = () => { setFormKey(current => current + 1); setOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }) }
  const formDefaults = previous ? {
    workTitle: previous.workTitle || requestTitle,
    recipientCompany: previous.recipientCompany || customerCompany,
    recipientName: previous.recipientName || customerName,
    recipientPhone: previous.recipientPhone || customerPhone,
    recipientFax: previous.recipientFax || "",
    senderName: previous.senderName || "",
    senderPhone: previous.senderPhone || "",
    senderFax: previous.senderFax || "",
    validityDays: previous.validityDays,
    paymentTerms: previous.paymentTerms || "",
    incoterm: previous.incoterm || "",
    leadTime: previous.leadTime || "",
    taxRate: previous.taxRate,
    notes: previous.notes || "",
    items: previous.items.map(item => ({ description: item.description, spec: item.spec, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice })),
    fromPrevious: true
  } : { workTitle: requestTitle, recipientCompany: customerCompany, recipientName: customerName, recipientPhone: customerPhone }
  return <section id="tao-bao-gia" className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-[0_18px_50px_-34px_rgba(15,23,42,.3)]">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/80 px-5 py-5 sm:px-7"><div><h3 className="flex items-center gap-2 font-display text-2xl font-bold text-emerald-950"><FileText className="size-6 text-orange-600"/>Báo giá</h3><p className="mt-1 text-sm text-slate-500">Mẫu in gửi cho <strong>{customerName}</strong> và email <strong>{customerEmail}</strong>.</p></div>{canCreate && <Button onClick={() => setOpen(!open)}><Plus className="size-4"/>{open ? "Thu gọn biểu mẫu" : shouldRevise ? "Lập báo giá thay thế" : "Tạo báo giá mới"}</Button>}</div>
    <div className="p-5 sm:p-7">
    {requestStatus === "quoted" && <div className="mb-5 flex items-start gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-4"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-100 text-violet-700"><CheckCheck className="size-5"/></span><div><strong className="text-violet-950">Báo giá đã được gửi</strong><p className="mt-1 text-sm leading-6 text-violet-800">Hiện đang chờ khách hàng đồng ý hoặc yêu cầu điều chỉnh. Không cần tạo thêm báo giá mới.</p></div></div>}
    {open && canCreate && <QuotationForm key={`${formKey}-${previous?._id || "new"}`} busy={busy} submitLabel="Gửi báo giá cho khách" defaults={formDefaults} onSubmit={body => onCreate({ ...body, status: "sent" }, resetForm)}/>}
    <div className="mt-6"><div className="flex items-center justify-between gap-3"><h4 className="font-display text-lg font-bold text-emerald-950">Lịch sử báo giá</h4><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-500">{quotations.length} phiên bản</span></div><div className="mt-3 space-y-3">{quotations.map(item => <div key={item._id} className="rounded-2xl border border-slate-200 p-4 transition hover:border-orange-200 hover:shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><strong className="font-mono text-sm text-emerald-950">{item.code}</strong><p className="mt-1 text-sm text-slate-500">Phiên bản {item.version} · Hiệu lực {item.validityDays ? `${item.validityDays} ngày` : `đến ${new Date(item.validUntil).toLocaleDateString("vi-VN")}`}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-700">{quotationStatusNames[item.status] || item.status}</span></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><Button size="sm" variant="outline" onClick={() => setExpandedQuote(expandedQuote === item._id ? "" : item._id)}><Eye className="size-4"/>{expandedQuote === item._id ? "Thu gọn" : "Xem chi tiết"}</Button><strong className="font-display text-xl text-orange-700">{money.format(item.total)}</strong></div>{expandedQuote === item._id && <QuotationDetail quotation={item}/>} {item.status === "draft" && canEdit && <div className="mt-3 rounded-xl bg-orange-50 p-3"><p className="text-sm text-orange-900"><Info className="mr-1 inline size-4"/>Bản nháp cũ này chưa gửi cho khách.</p><Button className="mt-2 w-full" size="sm" onClick={() => onSend(item._id)} disabled={busy}>Gửi báo giá này cho {customerName}</Button></div>}</div>)}{!quotations.length && <div className="rounded-card border border-dashed border-slate-300 bg-slate-50 py-12 text-center"><FileText className="mx-auto size-10 text-slate-300"/><p className="mt-3 text-slate-500">{requestStatus === "need_more_info" ? "Đang chờ khách hàng bổ sung thông tin trước khi báo giá." : "Chưa có báo giá cho yêu cầu này."}</p></div>}</div></div>
    </div>
  </section>
}

function QuotationDetail({ quotation }: { quotation: StaffRequestDetail["quotations"][number] }) {
  return <div className="mt-4 rounded-2xl bg-slate-50 p-4">
    {quotation.workTitle && <p className="mb-3 text-sm"><strong>Tên công việc:</strong> {quotation.workTitle}</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-slate-500"><tr><th className="pb-2">Tên vật tư</th><th className="pb-2">Spec</th><th className="pb-2 text-right">SL</th><th className="pb-2">Đơn vị</th><th className="pb-2 text-right">Đơn giá</th><th className="pb-2 text-right">Số tiền</th></tr></thead><tbody>{quotation.items.map((item, index) => <tr className="border-t border-slate-200" key={`${quotation._id}-${index}`}><td className="py-3 font-semibold text-slate-800">{item.description}</td><td className="py-3">{item.spec || "—"}</td><td className="py-3 text-right">{item.quantity}</td><td className="py-3">{item.unit}</td><td className="py-3 text-right">{money.format(item.unitPrice)}</td><td className="py-3 text-right font-bold">{money.format(item.lineTotal)}</td></tr>)}</tbody></table></div>
    <div className="ml-auto mt-4 max-w-sm space-y-2 border-t pt-3 text-sm">{quotation.taxAmount > 0 && <p className="flex justify-between"><span>VAT ({quotation.taxRate}%)</span><strong>{money.format(quotation.taxAmount)}</strong></p>}<p className="flex justify-between text-lg text-orange-700"><span className="font-bold">Tổng giá trị đơn hàng</span><strong>{money.format(quotation.total)}</strong></p></div>
    {quotation.paymentTerms && <p className="mt-3 text-sm"><strong>Điều kiện thanh toán:</strong> {quotation.paymentTerms}</p>}
    {quotation.incoterm && <p className="mt-1 text-sm"><strong>Điều kiện giao hàng:</strong> {quotation.incoterm}</p>}
    {quotation.leadTime && <p className="mt-1 text-sm"><strong>Thời gian giao hàng:</strong> {quotation.leadTime}</p>}
    {quotation.notes && <p className="mt-1 whitespace-pre-wrap text-sm"><strong>Ghi chú:</strong> {quotation.notes}</p>}
  </div>
}

function LeadQuotePanel({ lead, busy, error, onQuote, onReject }: { lead: StaffLead; busy: boolean; error: Error | null; onQuote: (body: Parameters<typeof staffClient.quoteLead>[1]) => void; onReject: (reason: string) => void }) {
  const closed = lead.status === "lost" || lead.status === "spam" || Boolean(lead.convertedRequest)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const [customerEmail, setCustomerEmail] = useState(lead.email || "")
  return <article className="space-y-6">
    <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-black uppercase tracking-wider text-orange-700">{lead.code} · Website</p>
      <h2 className="mt-2 font-display text-3xl font-bold text-emerald-950">{lead.name}</h2>
      <p className="mt-2 text-slate-600">{lead.serviceType || "Yêu cầu báo giá"} · {new Date(lead.createdAt).toLocaleString("vi-VN")}</p>
      <div className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-5 sm:grid-cols-2">
        <a className="font-bold text-emerald-800" href={`tel:${lead.phone}`}><Phone className="mr-2 inline size-4 text-orange-600"/>{lead.phone}</a>
        {lead.email && <a className="font-bold text-emerald-800" href={`mailto:${lead.email}`}><Mail className="mr-2 inline size-4 text-orange-600"/>{lead.email}</a>}
        <p className="whitespace-pre-wrap text-slate-700 sm:col-span-2">{lead.message || "Khách chưa để lại mô tả."}</p>
        {lead.budget && <p className="text-sm text-slate-600">Ngân sách: {lead.budget}</p>}
      </div>
      {error && <p className="mt-4 rounded-xl bg-red-50 p-4 font-semibold text-red-700">{error.message}</p>}
      {closed ? <p className="mt-5 rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">{lead.lostReason || "Hồ sơ này đã được xử lý."}</p> : rejecting ? <form className="mt-5 space-y-3" onSubmit={event => { event.preventDefault(); onReject(reason.trim()) }}><Textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Lý do từ chối, email này sẽ gửi cho khách"/><div className="flex gap-2"><Button disabled={busy || reason.trim().length < 3}>Gửi từ chối</Button><Button type="button" variant="ghost" onClick={() => setRejecting(false)}>Quay lại</Button></div></form> : <Button className="mt-5" variant="outline" onClick={() => setRejecting(true)}>Từ chối yêu cầu</Button>}
    </section>
    {!closed && <section className="rounded-card border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <h3 className="font-display text-2xl font-bold text-emerald-950">Gửi báo giá</h3>
      <p className="mt-1 text-sm text-slate-500">Báo giá theo mẫu công ty. Email đã có tài khoản thì nhận báo giá ngay. Email chưa có tài khoản thì hệ thống tạo tài khoản và gửi email đặt mật khẩu.</p>
      <label className="mt-5 block text-sm font-bold text-slate-700">Email khách nhận báo giá<Input className="mt-2" type="email" value={customerEmail} onChange={event => setCustomerEmail(event.target.value)} placeholder="email@khachhang.vn"/></label>
      <div className="mt-5"><QuotationForm busy={busy} submitLabel="Gửi báo giá" defaults={{ workTitle: lead.serviceType || "", recipientCompany: lead.company || "", recipientName: lead.name, recipientPhone: lead.phone }} onSubmit={body => onQuote({ ...body, customerEmail: customerEmail.trim() })}/></div>
    </section>}
  </article>
}
