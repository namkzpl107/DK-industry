import * as Dialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, CalendarClock, Check, ClipboardCheck, Eye, History, LayoutDashboard, LoaderCircle, MapPin, Navigation, PackageCheck, Phone, RefreshCw, RotateCcw, Search, SlidersHorizontal, Sparkles, Truck, UserCheck, Wrench, X } from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { Pagination } from "@/components/pagination"
import { StaffShell } from "@/components/staff/staff-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/numeric-input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { usePageMeta } from "@/hooks/use-page-meta"
import { googleMapsDirectionsUrl } from "@/lib/google-maps"
import { formatGroupedNumber, parseNumericInput } from "@/lib/numeric"
import { staffClient } from "@/lib/staff-client"
import { cn, formatAddressParts } from "@/lib/utils"
import type { OrderStatus, PaymentStatus, StaffOrder } from "@/types/staff"

type DetailTab = "overview" | "process" | "history"

const statusNames: Record<OrderStatus, string> = { pending: "Chờ xác nhận", confirmed: "Đã xác nhận", preparing: "Đã xác nhận", shipping: "Đang giao", delivered: "Hoàn tất", cancelled: "Đã hủy" }
const statusStyles: Record<OrderStatus, string> = { pending: "bg-amber-50 text-amber-800", confirmed: "bg-blue-50 text-blue-800", preparing: "bg-blue-50 text-blue-800", shipping: "bg-cyan-50 text-cyan-800", delivered: "bg-emerald-50 text-emerald-800", cancelled: "bg-red-50 text-red-700" }
const paymentNames: Record<PaymentStatus, string> = { unpaid: "Chưa thanh toán", pending: "Chờ đối soát", paid: "Đã thanh toán", refund_pending: "Chờ hoàn tiền", refunded: "Đã hoàn tiền" }
const nextStatuses: Record<OrderStatus, OrderStatus[]> = { pending: ["confirmed", "cancelled"], confirmed: ["shipping", "cancelled"], preparing: ["shipping", "cancelled"], shipping: ["delivered"], delivered: [], cancelled: [] }
const actionNames: Partial<Record<OrderStatus, string>> = { confirmed: "Xác nhận đơn", shipping: "Bắt đầu giao hàng", delivered: "Hoàn tất đơn" }
const paymentTransitions: Record<PaymentStatus, PaymentStatus[]> = { unpaid: ["pending", "paid"], pending: ["unpaid", "paid"], paid: ["refund_pending"], refund_pending: ["refunded"], refunded: [] }
const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" })
const orderSteps: Array<{ status: OrderStatus; label: string }> = [{ status: "pending", label: "Đã đặt" }, { status: "confirmed", label: "Xác nhận" }, { status: "shipping", label: "Đang giao" }, { status: "delivered", label: "Hoàn tất" }]

export function StaffOrdersWorkspacePage() {
  usePageMeta("Đơn sản phẩm", "Tiếp nhận và theo dõi các đơn mua sản phẩm.")
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [filters, setFilters] = useState({ q: "", status: params.get("status") || "", paymentStatus: "", assigned: params.get("assigned") || "" })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(params.get("orderId") || "")
  useEffect(() => { setSelected(params.get("orderId") || "") }, [params])
  const list = useQuery({ queryKey: ["staff", "orders", filters, page], queryFn: () => staffClient.orders({ ...filters, page }) })
  const detail = useQuery({ queryKey: ["staff", "order", selected], queryFn: () => staffClient.order(selected), enabled: Boolean(selected) })

  useEffect(() => setPage(1), [filters])
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["staff", "orders"] })
    void queryClient.invalidateQueries({ queryKey: ["staff", "order", selected] })
    void queryClient.invalidateQueries({ queryKey: ["staff", "dashboard"] })
  }
  const update = useMutation({ mutationFn: (body: Parameters<typeof staffClient.updateOrder>[1]) => staffClient.updateOrder(selected, body), onSuccess: result => { toast.success(result.message || "Đã lưu thay đổi đơn hàng"); refresh() }, onError: error => toast.error(error.message) })
  const afterSales = useMutation({ mutationFn: ({ requestId, status, resolution }: { requestId: string; status: string; resolution?: string }) => staffClient.updateAfterSales(selected, requestId, { status, resolution }), onSuccess: result => { toast.success(result.message || "Đã cập nhật yêu cầu hậu mãi"); refresh() }, onError: error => toast.error(error.message) })
  const items = list.data?.data.items || []
  const hasFilters = Boolean(filters.q || filters.status || filters.paymentStatus || filters.assigned)

  return <StaffShell title="Đơn sản phẩm" description="Kiểm tra tồn kho, xác nhận và theo dõi giao hàng sản phẩm.">
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-emerald-950 px-5 py-5 text-white sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-orange-300 ring-1 ring-white/15"><Sparkles className="size-5"/></span><div><h2 className="font-display text-xl font-bold">Danh sách đơn hàng</h2><p className="mt-1 text-sm text-emerald-100/70">Chọn một đơn để xem và xử lý ngay trong cửa sổ làm việc.</p></div></div><div className="flex items-center gap-2"><span className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-emerald-950">{list.data?.data.total || 0} đơn</span><button type="button" onClick={() => void list.refetch()} className="grid size-10 place-items-center rounded-xl bg-white/10 text-white ring-1 ring-white/15 transition hover:bg-white/20" aria-label="Làm mới danh sách"><RefreshCw className={cn("size-4", list.isFetching && "animate-spin")}/></button></div></div>
      </div>
      <div className="border-b border-slate-200 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-500"><SlidersHorizontal className="size-4 text-orange-600"/>Tìm kiếm và lọc</span>{hasFilters && <button type="button" onClick={() => setFilters({ q: "", status: "", paymentStatus: "", assigned: "" })} className="flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-orange-700"><RotateCcw className="size-3.5"/>Xóa bộ lọc</button>}</div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_190px_190px_180px]">
          <label className="relative"><Search className="absolute left-3 top-3.5 size-5 text-slate-400"/><Input className="pl-10" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} placeholder="Mã đơn, người nhận, điện thoại..."/></label>
          <Filter value={filters.status} onChange={status => setFilters({ ...filters, status })} first="Mọi trạng thái" options={[["pending", "Chờ xác nhận"], ["confirmed", "Đã xác nhận"], ["shipping", "Đang giao"], ["delivered", "Hoàn tất"], ["cancelled", "Đã hủy"]]}/>
          <Filter value={filters.paymentStatus} onChange={paymentStatus => setFilters({ ...filters, paymentStatus })} first="Mọi thanh toán" options={Object.entries(paymentNames)}/>
          <Filter value={filters.assigned} onChange={assigned => setFilters({ ...filters, assigned })} first="Tất cả phụ trách" options={[["mine", "Của tôi"], ["unassigned", "Chưa phân công"]]}/>
        </div>
      </div>

      <div className="hidden grid-cols-[1.05fr_1fr_150px_150px_140px_42px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-black uppercase tracking-wider text-slate-500 lg:grid"><span>Đơn hàng</span><span>Người nhận</span><span>Trạng thái</span><span>Phụ trách</span><span className="text-right">Tổng tiền</span><span/></div>
      <div className="max-h-[min(58vh,620px)] min-h-72 overflow-y-auto">
        {items.map(item => <button type="button" key={item._id} onClick={() => setSelected(item._id)} className={cn("group grid w-full grid-cols-[1fr_auto] items-center gap-3 border-b border-l-4 border-b-slate-100 px-4 py-4 text-left transition last:border-b-0 hover:bg-orange-50/60 sm:px-5 lg:grid-cols-[1.05fr_1fr_150px_150px_140px_42px] lg:gap-4", item.status === "pending" ? "border-l-amber-400" : item.status === "shipping" ? "border-l-cyan-500" : item.status === "delivered" ? "border-l-emerald-500" : item.status === "cancelled" ? "border-l-red-300" : "border-l-blue-400")}>
          <div className="min-w-0"><strong className="block text-emerald-950">{item.code}</strong><span className="mt-1 block text-xs text-slate-500">{new Date(item.createdAt).toLocaleDateString("vi-VN")} · {item.items.length} dòng hàng</span></div>
          <span className="grid size-9 place-items-center rounded-xl bg-orange-50 text-orange-600 transition group-hover:bg-orange-600 group-hover:text-white lg:order-last"><Eye className="size-4"/></span>
          <div className="min-w-0 lg:col-auto"><strong className="block truncate text-sm text-slate-700">{item.shippingAddress.recipientName}</strong><span className="mt-1 block text-xs text-slate-500">{item.shippingAddress.phone}</span></div>
          <span className={cn("w-fit rounded-full px-3 py-1 text-xs font-black", statusStyles[item.status])}>{statusNames[item.status]}</span>
          <span className={cn("text-sm font-semibold", item.assignedTo ? "text-slate-600" : "text-amber-700")}>{item.assignedTo?.name || "Chưa nhận"}</span>
          <div className="lg:text-right"><strong className="block text-orange-700">{money.format(item.total)}</strong><span className="mt-1 block text-xs text-slate-500">{paymentNames[item.paymentStatus]}</span></div>
        </button>)}
        {list.isLoading && <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div>}
        {list.error && <p role="alert" className="m-5 rounded-2xl bg-red-50 p-4 font-semibold text-red-700">{list.error.message}</p>}
        {!list.isLoading && !items.length && <div className="grid min-h-72 place-items-center p-8 text-center"><div><PackageCheck className="mx-auto size-12 text-slate-300"/><h3 className="mt-3 font-display text-xl font-bold text-emerald-950">Không có đơn phù hợp</h3><p className="mt-1 text-sm text-slate-500">Thử thay đổi từ khóa hoặc bộ lọc.</p></div></div>}
      </div>
      <div className="border-t border-slate-200 px-4 py-3"><Pagination page={list.data?.data.page || page} pages={list.data?.data.pages || 1} onChange={setPage}/></div>
    </section>

    <OrderDialog error={detail.error?.message} open={Boolean(selected)} onOpenChange={open => { if (!open && !update.isPending && !afterSales.isPending) setSelected("") }} loading={detail.isLoading} order={detail.data?.data} busy={update.isPending || afterSales.isPending} onUpdate={body => update.mutate(body)} onAfterSales={(requestId, status, resolution) => afterSales.mutate({ requestId, status, resolution })}/>
  </StaffShell>
}

function OrderDialog({ error, open, onOpenChange, loading, order, busy, onUpdate, onAfterSales }: { error?: string; open: boolean; onOpenChange: (open: boolean) => void; loading: boolean; order?: StaffOrder; busy: boolean; onUpdate: (body: Parameters<typeof staffClient.updateOrder>[1]) => void; onAfterSales: (requestId: string, status: string, resolution?: string) => void }) {
  const [tab, setTab] = useState<DetailTab>("overview")
  useEffect(() => setTab("overview"), [order?._id])
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[110] bg-emerald-950/65 "/>
    <Dialog.Content aria-describedby="staff-order-dialog-description" className="fixed left-1/2 top-1/2 z-[111] flex h-[min(92vh,900px)] w-[min(1220px,calc(100%-20px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-slate-100 shadow-2xl outline-none">
      {error ? <div className="p-8"><Dialog.Title className="font-bold text-red-700">Không thể mở đơn hàng</Dialog.Title><p role="alert" className="my-4 text-red-700">{error}</p><Button variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button></div> : loading || !order ? <div className="grid flex-1 place-items-center"><LoaderCircle className="size-9 animate-spin text-orange-600"/></div> : <>
        <header className="shrink-0 border-b border-slate-200 bg-white px-5 py-4 sm:px-7">
          <div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={cn("rounded-full px-3 py-1 text-xs font-black", statusStyles[order.status])}>{statusNames[order.status]}</span><span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-black text-orange-800">{paymentNames[order.paymentStatus]}</span></div><Dialog.Title className="mt-2 truncate font-display text-2xl font-bold text-emerald-950 sm:text-3xl">{order.code} · {order.shippingAddress.recipientName}</Dialog.Title><Dialog.Description id="staff-order-dialog-description" className="mt-1 text-sm text-slate-500">{order.customer.name} · {new Date(order.createdAt).toLocaleString("vi-VN")}</Dialog.Description></div><Dialog.Close className="grid size-11 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-orange-300 hover:text-orange-700" aria-label="Đóng"><X className="size-5"/></Dialog.Close></div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end"><OrderProgress status={order.status}/><nav className="flex gap-2 overflow-x-auto" aria-label="Nội dung đơn hàng">{([['overview', 'Tổng quan', LayoutDashboard], ['process', 'Xử lý đơn', ClipboardCheck], ['history', 'Lịch sử', History]] as Array<[DetailTab, string, typeof History]>).map(([value, label, Icon]) => <button type="button" key={value} onClick={() => setTab(value)} className={cn("flex min-h-10 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold transition", tab === value ? "bg-emerald-950 text-white shadow-md" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}><Icon className="size-4"/>{label}{value === 'history' && order.afterSalesRequests?.length ? ` (${order.afterSalesRequests.length})` : ''}</button>)}</nav></div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {tab === "overview" && <OverviewTab order={order}/>} 
          {tab === "process" && <ProcessTab order={order} busy={busy} onUpdate={onUpdate}/>} 
          {tab === "history" && <HistoryTab order={order} busy={busy} onAfterSales={onAfterSales}/>} 
        </div>
      </>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function OverviewTab({ order }: { order: StaffOrder }) {
  const directionsUrl = order.shippingAddress.latitude !== undefined && order.shippingAddress.longitude !== undefined ? googleMapsDirectionsUrl(order.shippingAddress.latitude, order.shippingAddress.longitude) : ""
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Tổng đơn" value={money.format(order.total)}/><Metric label="Thanh toán" value={paymentNames[order.paymentStatus]}/><Metric label="Phụ trách" value={order.assignedTo?.name || "Chưa có người nhận"}/><Metric label="Hình thức" value={order.paymentMethod === "cod" ? "Thanh toán khi nhận" : "Chuyển khoản"}/></div>
    <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
      <Card title="Thông tin giao nhận" icon={<MapPin/>}><div className="space-y-4 text-sm text-slate-600"><p><strong className="block text-slate-900">{order.shippingAddress.recipientName}</strong>{formatAddressParts([order.shippingAddress.addressLine, order.shippingAddress.ward, order.shippingAddress.district, order.shippingAddress.province])}</p><a className="flex min-h-11 items-center gap-2 font-bold text-emerald-800" href={`tel:${order.shippingAddress.phone}`}><Phone className="size-4 text-orange-600"/>{order.shippingAddress.phone}</a>{order.shippingProvider && <p><strong className="block text-slate-900">{order.shippingProvider}</strong>{order.trackingCode ? `Mã vận đơn: ${order.trackingCode}` : "Chưa có mã vận đơn"}{order.estimatedDeliveryAt && <span className="mt-1 block">Dự kiến: {new Date(order.estimatedDeliveryAt).toLocaleString("vi-VN")}</span>}</p>}{directionsUrl && <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 font-bold text-emerald-800" href={directionsUrl} target="_blank" rel="noreferrer"><Navigation className="size-4"/>Mở chỉ đường</a>}</div></Card>
      <Card title="Sản phẩm trong đơn" icon={<PackageCheck/>}><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-b text-slate-500"><tr><th className="pb-3">Sản phẩm</th><th>SL</th><th>Đơn giá</th><th className="text-right">Thành tiền</th></tr></thead><tbody>{order.items.map(item => <tr key={item._id} className="border-b border-slate-100 last:border-0"><td className="py-3 font-bold text-emerald-950">{item.name}<span className="block text-xs font-normal text-slate-500">{item.sku}</span></td><td>{item.quantity} {item.unit}</td><td>{money.format(item.price)}</td><td className="text-right font-bold">{money.format(item.lineTotal)}</td></tr>)}</tbody></table></div><div className="ml-auto mt-4 max-w-xs space-y-2 text-sm"><p className="flex justify-between"><span className="text-slate-500">Tiền hàng</span><strong>{money.format(order.subtotal)}</strong></p><p className="flex justify-between"><span className="text-slate-500">Vận chuyển</span><strong>{money.format(order.shippingFee)}</strong></p><p className="flex justify-between border-t pt-2 text-lg"><span>Tổng</span><strong className="text-orange-700">{money.format(order.total)}</strong></p></div></Card>
    </div>
    {order.customerNote && <Card title="Ghi chú của khách" icon={<History/>}><p className="text-sm leading-6 text-slate-600">{order.customerNote}</p></Card>}
  </div>
}

function ProcessTab({ order, busy, onUpdate }: { order: StaffOrder; busy: boolean; onUpdate: (body: Parameters<typeof staffClient.updateOrder>[1]) => void }) {
  const [nextStatus, setNextStatus] = useState("")
  const [paymentStatus, setPaymentStatus] = useState("")
  const [message, setMessage] = useState("")
  const [amountPaid, setAmountPaid] = useState(formatGroupedNumber(order.total))
  const [paymentReference, setPaymentReference] = useState(order.paymentReference || "")
  const [internalNote, setInternalNote] = useState(order.internalNote || "")
  const [shippingFee, setShippingFee] = useState(formatGroupedNumber(order.shippingFee || 0))
  const [shippingProvider, setShippingProvider] = useState(order.shippingProvider || "")
  const [trackingCode, setTrackingCode] = useState(order.trackingCode || "")
  const [estimatedDeliveryAt, setEstimatedDeliveryAt] = useState(order.estimatedDeliveryAt?.slice(0, 16) || "")
  const [deliveryRecipientName, setDeliveryRecipientName] = useState(order.deliveryRecipientName || order.shippingAddress.recipientName)
  const [deliveryConfirmed, setDeliveryConfirmed] = useState(false)
  useEffect(() => { setNextStatus(nextStatuses[order.status].find(status => status !== "cancelled") || ""); setPaymentStatus(""); setMessage(""); setAmountPaid(formatGroupedNumber(order.total)); setPaymentReference(order.paymentReference || ""); setInternalNote(order.internalNote || ""); setShippingFee(formatGroupedNumber(order.shippingFee || 0)); setShippingProvider(order.shippingProvider || ""); setTrackingCode(order.trackingCode || ""); setEstimatedDeliveryAt(order.estimatedDeliveryAt?.slice(0, 16) || ""); setDeliveryRecipientName(order.deliveryRecipientName || order.shippingAddress.recipientName); setDeliveryConfirmed(false) }, [order])
  const allowedPayments = paymentTransitions[order.paymentStatus].filter(status => (status !== "refund_pending" || order.status === "cancelled") && !(status === "paid" && order.paymentMethod === "cod"))
  const submit = (event: FormEvent) => { event.preventDefault(); const body: Parameters<typeof staffClient.updateOrder>[1] = { message }; if (!["delivered", "cancelled"].includes(order.status)) { body.shippingProvider = shippingProvider; body.trackingCode = trackingCode; body.estimatedDeliveryAt = estimatedDeliveryAt } if (["pending", "confirmed", "preparing"].includes(order.status)) body.shippingFee = parseNumericInput(shippingFee); if (nextStatus) body.status = nextStatus as OrderStatus; if (nextStatus === "delivered") { body.deliveryConfirmed = deliveryConfirmed; body.deliveryRecipientName = deliveryRecipientName.trim() } if (paymentStatus) { body.paymentStatus = paymentStatus as PaymentStatus; if (paymentStatus === "paid") { body.amountPaid = parseNumericInput(amountPaid); body.paymentReference = paymentReference } if (paymentStatus === "refunded") body.paymentReference = paymentReference } onUpdate(body) }
  if (!order.assignedTo && ["delivered", "cancelled"].includes(order.status)) return <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><PackageCheck className="mx-auto size-12 text-emerald-700"/><h3 className="mt-4 font-display text-2xl font-bold text-emerald-950">Đơn hàng đã kết thúc</h3><p className="mt-2 text-slate-600">Đơn đã {order.status === "cancelled" ? "hủy" : "hoàn tất"}, không thể nhận xử lý hoặc thay đổi vận chuyển.</p></div>
  if (!order.assignedTo) return <div className="mx-auto max-w-xl rounded-3xl border border-amber-200 bg-white p-8 text-center shadow-sm"><UserCheck className="mx-auto size-12 text-amber-600"/><h3 className="mt-4 font-display text-2xl font-bold text-emerald-950">Đơn chưa có người phụ trách</h3><p className="mt-2 text-slate-600">Nhận đơn trước để tránh nhiều nhân viên xử lý trùng.</p><Button className="mt-5" disabled={busy} onClick={() => onUpdate({ assignedTo: "me" })}><UserCheck className="size-5"/>Nhận xử lý đơn</Button></div>
  return <div className="space-y-5"><div className="grid gap-5 xl:grid-cols-2">
    <Card title="Thông tin giao hàng" icon={<Truck/>}><div className="grid gap-3 sm:grid-cols-2"><Field label="Phí vận chuyển (VND)"><MoneyInput min="0" disabled={Boolean(order.paymentLockedAt) || ["shipping", "delivered", "cancelled"].includes(order.status)} value={shippingFee} onChange={event => setShippingFee(event.target.value)}/></Field><Field label="Đơn vị / hình thức vận chuyển"><Input disabled={["delivered", "cancelled"].includes(order.status)} value={shippingProvider} onChange={event => setShippingProvider(event.target.value)} placeholder="Viettel Post hoặc xe công ty"/></Field><Field label="Mã vận đơn"><Input disabled={["delivered", "cancelled"].includes(order.status)} value={trackingCode} onChange={event => setTrackingCode(event.target.value)} placeholder="Có thể để trống"/></Field><Field label="Thời gian giao dự kiến"><Input disabled={["delivered", "cancelled"].includes(order.status)} type="datetime-local" value={estimatedDeliveryAt} onChange={event => setEstimatedDeliveryAt(event.target.value)}/></Field></div></Card>
    <Card title="Bước xử lý tiếp theo" icon={<PackageCheck/>}>{!nextStatuses[order.status].length && !allowedPayments.length ? <p className="rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">Đơn đã kết thúc, không còn bước xử lý tiếp theo.</p> : <form className="grid gap-3" onSubmit={submit}><div className="grid gap-3 sm:grid-cols-2"><Filter value={nextStatus} onChange={setNextStatus} first="Không đổi tiến trình" options={nextStatuses[order.status].map(status => [status, statusNames[status]])}/><Filter value={paymentStatus} onChange={setPaymentStatus} first="Không đổi thanh toán" options={allowedPayments.map(status => [status, paymentNames[status]])}/></div>{paymentStatus === "paid" && <div className="grid gap-3 sm:grid-cols-2"><Field label="Số tiền thực nhận"><MoneyInput min="0" value={amountPaid} onChange={event => setAmountPaid(event.target.value)}/></Field><Field label="Mã giao dịch"><Input value={paymentReference} onChange={event => setPaymentReference(event.target.value)} placeholder="FT24200123456"/></Field></div>}{paymentStatus === "refunded" && <Field label="Mã giao dịch hoàn tiền"><Input value={paymentReference} onChange={event => setPaymentReference(event.target.value)}/></Field>}{nextStatus === "delivered" && <div className="grid gap-3 sm:grid-cols-2"><Field label="Người đã nhận hàng"><Input value={deliveryRecipientName} onChange={event => setDeliveryRecipientName(event.target.value)}/></Field><label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-bold text-emerald-900"><input className="size-5 accent-emerald-700" type="checkbox" checked={deliveryConfirmed} onChange={event => setDeliveryConfirmed(event.target.checked)}/>Đã giao đủ hàng</label></div>}<Input value={message} onChange={event => setMessage(event.target.value)} placeholder={nextStatus === "cancelled" ? "Bắt buộc nhập lý do hủy" : "Nội dung khách hàng sẽ nhìn thấy"}/><Button disabled={busy || (!nextStatus && !paymentStatus) || (nextStatus === "cancelled" && message.trim().length < 5) || (nextStatus === "delivered" && (!deliveryConfirmed || deliveryRecipientName.trim().length < 2)) || (paymentStatus === "paid" && order.paymentMethod === "bank_transfer" && paymentReference.trim().length < 3)}>{nextStatus ? actionNames[nextStatus as OrderStatus] || statusNames[nextStatus as OrderStatus] : "Cập nhật thanh toán"}</Button></form>}{order.paymentMethod === "bank_transfer" && order.paymentStatus !== "paid" && <p className="mt-3 flex gap-2 text-sm text-amber-700"><Banknote className="size-4 shrink-0"/>Cần xác nhận thanh toán trước khi bắt đầu giao.</p>}</Card>
  </div><Card title="Ghi chú nội bộ" icon={<History/>}><Textarea value={internalNote} onChange={event => setInternalNote(event.target.value)} placeholder="Thông tin kho, hóa đơn VAT, vận chuyển..."/><Button className="mt-3" variant="outline" disabled={busy} onClick={() => onUpdate({ internalNote })}>Lưu ghi chú</Button></Card></div>
}

function HistoryTab({ order, busy, onAfterSales }: { order: StaffOrder; busy: boolean; onAfterSales: (requestId: string, status: string, resolution?: string) => void }) {
  return <div className="space-y-5"><div className="grid gap-5 lg:grid-cols-2"><Card title="Tiến trình đơn hàng" icon={<History/>}><Timeline entries={order.timeline.map(item => ({ label: statusNames[item.status as OrderStatus] || item.status, message: item.message, at: item.at }))}/></Card><Card title="Đối soát thanh toán" icon={<Banknote/>}><Timeline entries={(order.paymentTimeline || []).map(item => ({ label: paymentNames[item.status], message: item.message, at: item.at }))}/></Card></div>{order.status === "delivered" && <p className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900"><strong>Hoàn tất:</strong> {order.deliveryRecipientName || order.shippingAddress.recipientName}{order.customerConfirmedAt ? ` · Khách xác nhận lúc ${new Date(order.customerConfirmedAt).toLocaleString("vi-VN")}` : " · Chưa có xác nhận thêm từ khách"}</p>}{order.afterSalesRequests?.length ? <Card title="Yêu cầu hậu mãi cũ" icon={<Wrench/>}><div className="space-y-4">{order.afterSalesRequests.map(item => <AfterSalesItem key={item._id} item={item} busy={busy} onUpdate={(status, resolution) => onAfterSales(item._id, status, resolution)}/>)}</div></Card> : null}</div>
}

function OrderProgress({ status }: { status: OrderStatus }) {
  if (status === "cancelled") return <div className="flex min-h-10 items-center gap-2 rounded-xl bg-red-50 px-4 text-sm font-bold text-red-700"><X className="size-4"/>Đơn hàng đã hủy</div>
  const normalizedStatus = status === "preparing" ? "confirmed" : status
  const current = Math.max(0, orderSteps.findIndex(step => step.status === normalizedStatus))
  return <div className="overflow-x-auto pb-1"><ol className="grid min-w-[420px] grid-cols-4" aria-label="Tiến trình đơn hàng">{orderSteps.map((step, index) => {
    const done = index < current || normalizedStatus === "delivered"
    const active = index === current && normalizedStatus !== "delivered"
    return <li key={step.status} className="relative flex items-center"><span className={cn("absolute left-3 right-0 top-3.5 h-0.5", index === orderSteps.length - 1 ? "hidden" : index < current ? "bg-emerald-600" : "bg-slate-200")}/><span className={cn("relative z-10 grid size-7 place-items-center rounded-full border-2 bg-white", done ? "border-emerald-600 bg-emerald-600 text-white" : active ? "border-orange-500 text-orange-600" : "border-slate-300 text-slate-300")}>{done ? <Check className="size-4"/> : <span className="size-2 rounded-full bg-current"/>}</span><span className={cn("relative z-10 ml-2 bg-white pr-2 text-xs font-bold", done || active ? "text-emerald-900" : "text-slate-400")}>{step.label}</span></li>
  })}</ol></div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</span><strong className="mt-2 block truncate text-base text-emerald-950">{value}</strong></div> }
function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="mb-4 flex items-center gap-2 font-display text-lg font-bold text-emerald-950"><span className="grid size-9 place-items-center rounded-xl bg-orange-50 text-orange-700 [&>svg]:size-5">{icon}</span>{title}</h3>{children}</section> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="text-sm font-bold text-slate-700">{label}<span className="mt-2 block">{children}</span></label> }
function Timeline({ entries }: { entries: Array<{ label: string; message?: string; at: string }> }) { return entries.length ? <ol className="space-y-3">{entries.map((item, index) => <li className="flex gap-3 text-sm" key={`${item.at}-${index}`}><span className="mt-1.5 size-2 shrink-0 rounded-full bg-orange-500"/><div><strong>{item.label}</strong>{item.message && <p className="mt-1 text-slate-500">{item.message}</p>}<time className="mt-1 flex items-center gap-1 text-xs text-slate-400"><CalendarClock className="size-3"/>{new Date(item.at).toLocaleString("vi-VN")}</time></div></li>)}</ol> : <p className="text-sm text-slate-400">Chưa có cập nhật.</p> }
function AfterSalesItem({ item, busy, onUpdate }: { item: NonNullable<StaffOrder["afterSalesRequests"]>[number]; busy: boolean; onUpdate: (status: string, resolution?: string) => void }) { const options: Record<string, string[]> = { submitted: ["reviewing", "rejected"], reviewing: ["approved", "rejected"], approved: ["received", "resolved"], received: ["resolved"], rejected: [], resolved: [] }; const [status, setStatus] = useState(""); const [resolution, setResolution] = useState(item.resolution || ""); return <div className="rounded-2xl border bg-slate-50 p-4"><strong className="text-emerald-950">{item.type === "warranty" ? "Bảo hành" : item.type === "return" ? "Đổi / trả" : "Khiếu nại"} · {item.status}</strong><p className="mt-2 text-sm text-slate-600">{item.reason}</p>{options[item.status]?.length > 0 && <div className="mt-3 grid gap-3 sm:grid-cols-[190px_1fr_auto]"><Filter value={status} onChange={setStatus} first="Chọn bước xử lý" options={options[item.status].map(value => [value, value])}/><Input value={resolution} onChange={event => setResolution(event.target.value)} placeholder="Kết quả / hướng xử lý"/><Button disabled={busy || !status || (["rejected", "resolved"].includes(status) && resolution.trim().length < 5)} onClick={() => onUpdate(status, resolution.trim())}>Cập nhật</Button></div>}</div> }
function Filter({ value, onChange, first, options }: { value: string; onChange: (value: string) => void; first: string; options: string[][] }) { return <Select ariaLabel={first} value={value} onChange={onChange} options={[{ value: "", label: first }, ...options.map(([optionValue, label]) => ({ value: optionValue, label }))]}/> }
