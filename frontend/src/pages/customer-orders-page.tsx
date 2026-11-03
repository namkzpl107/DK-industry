import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, Check, CheckCircle2, ChevronRight, Clock3, LoaderCircle, MapPin, PackageOpen, Truck, XCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CustomerShell } from "@/components/customer/customer-shell"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { usePageMeta } from "@/hooks/use-page-meta"
import { customerClient } from "@/lib/customer-client"
import { cn, formatAddressParts, formatPrice, scrollToPageTop } from "@/lib/utils"
import type { CustomerOrder, PaymentStatus } from "@/types/customer"

type OrderGroup = "all" | "pending" | "confirmed" | "shipping" | "delivered" | "cancelled"

const statuses: Record<string, { label: string; className: string }> = {
  pending: { label: "Chờ xác nhận", className: "bg-amber-50 text-amber-800" },
  confirmed: { label: "Đã xác nhận", className: "bg-blue-50 text-blue-800" },
  preparing: { label: "Đã xác nhận", className: "bg-blue-50 text-blue-800" },
  shipping: { label: "Đang giao", className: "bg-cyan-50 text-cyan-800" },
  delivered: { label: "Hoàn tất", className: "bg-emerald-50 text-emerald-800" },
  cancelled: { label: "Đã hủy", className: "bg-red-50 text-red-700" },
}
const paymentNames: Record<PaymentStatus, string> = {
  unpaid: "Chưa thanh toán", pending: "Chờ đối soát", paid: "Đã thanh toán", refund_pending: "Chờ hoàn tiền", refunded: "Đã hoàn tiền",
}
const progressSteps = [
  { status: "pending", label: "Đã đặt hàng" },
  { status: "confirmed", label: "Xác nhận" },
  { status: "shipping", label: "Đang giao" },
  { status: "delivered", label: "Hoàn tất" },
]
const tabs: Array<{ value: OrderGroup; label: string }> = [
  { value: "all", label: "Tất cả" },
  { value: "pending", label: "Chờ xác nhận" },
  { value: "confirmed", label: "Đã xác nhận" },
  { value: "shipping", label: "Đang giao" },
  { value: "delivered", label: "Hoàn tất" },
  { value: "cancelled", label: "Đã hủy" },
]

const orderGroup = (status: string): OrderGroup => status === "preparing" ? "confirmed" : status as OrderGroup

export function CustomerOrdersPage() {
  usePageMeta("Đơn sản phẩm", "Theo dõi thanh toán và giao nhận sản phẩm tại một nơi.")
  const queryClient = useQueryClient()
  const toast = useToast()
  const [activeGroup, setActiveGroup] = useState<OrderGroup>("all")
  const [params] = useSearchParams()
  const linkedOrderId = params.get("orderId") || ""
  const [selectedId, setSelectedId] = useState(linkedOrderId)
  useEffect(() => { setSelectedId(linkedOrderId); setActiveGroup("all") }, [linkedOrderId])
  const orders = useQuery({ queryKey: ["customer", "orders"], queryFn: customerClient.orders })
  const allOrders = useMemo(() => orders.data?.data || [], [orders.data])
  const filteredOrders = useMemo(() => activeGroup === "all" ? allOrders : allOrders.filter(order => orderGroup(order.status) === activeGroup), [activeGroup, allOrders])
  const selectedOrder = filteredOrders.find(order => order._id === selectedId) || (linkedOrderId && selectedId === linkedOrderId && activeGroup === "all" ? undefined : filteredOrders[0])

  useEffect(() => {
    if (!linkedOrderId && filteredOrders.length && !filteredOrders.some(order => order._id === selectedId)) setSelectedId(filteredOrders[0]._id)
  }, [filteredOrders, selectedId, linkedOrderId])

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => customerClient.cancelOrder(id, reason),
    onSuccess: async (result, { id }) => {
      toast.success(result.message || "Đã hủy đơn")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["customer", "orders"] }),
        queryClient.invalidateQueries({ queryKey: ["customer", "summary"] }),
      ])
      setActiveGroup("cancelled")
      setSelectedId(id)
      scrollToPageTop()
    },
    onError: error => toast.error(error.message),
  })
  const confirmReceived = useMutation({
    mutationFn: (id: string) => customerClient.confirmOrderReceived(id),
    onSuccess: async (result, id) => {
      toast.success(result.message || "Đã xác nhận nhận hàng")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["customer", "orders"] }),
        queryClient.invalidateQueries({ queryKey: ["customer", "summary"] }),
      ])
      setActiveGroup("delivered")
      setSelectedId(id)
      scrollToPageTop()
    },
    onError: error => toast.error(error.message),
  })
  const counts = useMemo(() => tabs.reduce<Record<OrderGroup, number>>((result, tab) => {
    result[tab.value] = tab.value === "all" ? allOrders.length : allOrders.filter(order => orderGroup(order.status) === tab.value).length
    return result
  }, { all: 0, pending: 0, confirmed: 0, shipping: 0, delivered: 0, cancelled: 0 }), [allOrders])

  return <CustomerShell title="Đơn sản phẩm" description="Theo dõi xác nhận, thanh toán và giao nhận từng đơn sản phẩm.">
    {orders.isLoading ? <Loading/> : orders.error ? <ErrorText error={orders.error}/> : !allOrders.length ? <Empty/> : <>
      <nav aria-label="Lọc đơn hàng theo trạng thái" className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {tabs.map(tab => <button key={tab.value} type="button" onClick={() => setActiveGroup(tab.value)} className={cn("flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold transition", activeGroup === tab.value ? "bg-emerald-950 text-white shadow-md" : "text-slate-600 hover:bg-slate-100 hover:text-emerald-950")}><span>{tab.label}</span><span className={cn("rounded-full px-2 py-0.5 text-xs", activeGroup === tab.value ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500")}>{counts[tab.value]}</span></button>)}
      </nav>
      <div className="grid items-start gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm lg:sticky lg:top-24">
          <div className="border-b border-slate-100 px-5 py-4"><h2 className="font-display text-lg font-bold text-emerald-950">{tabs.find(tab => tab.value === activeGroup)?.label}</h2><p className="mt-1 text-sm text-slate-500">{filteredOrders.length} đơn hàng</p></div>
          <div className="max-h-[430px] space-y-2 overflow-y-auto p-3 lg:max-h-[calc(100vh-260px)]">
            {filteredOrders.length ? filteredOrders.map(order => <OrderListItem key={order._id} order={order} selected={order._id === selectedOrder?._id} onSelect={() => setSelectedId(order._id)}/>) : <div className="px-4 py-12 text-center"><PackageOpen className="mx-auto size-9 text-slate-300"/><p className="mt-3 text-sm text-slate-500">Chưa có đơn ở trạng thái này.</p></div>}
          </div>
        </aside>
        {selectedOrder ? <OrderDetail order={selectedOrder} busy={cancel.isPending || confirmReceived.isPending} onCancel={reason => cancel.mutate({ id: selectedOrder._id, reason })} onConfirmReceived={() => confirmReceived.mutate(selectedOrder._id)}/> : <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">Chọn nhóm trạng thái có đơn hàng để xem chi tiết.</div>}
      </div>
    </>}
    <div className="mt-5 flex items-start gap-3 rounded-2xl bg-blue-50 p-4 text-sm leading-6 text-blue-900"><Truck className="mt-0.5 size-5 shrink-0"/><p>Phí và lịch giao chính thức được cập nhật sau khi nhân viên xác nhận đơn.</p></div>
  </CustomerShell>
}

function OrderListItem({ order, selected, onSelect }: { order: CustomerOrder; selected: boolean; onSelect: () => void }) {
  const status = statuses[order.status] || { label: order.status, className: "bg-slate-100 text-slate-700" }
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0)
  return <button type="button" onClick={onSelect} className={cn("w-full rounded-2xl border p-4 text-left transition", selected ? "border-orange-400 bg-orange-50/60 shadow-sm ring-2 ring-orange-100" : "border-transparent bg-slate-50 hover:border-slate-200 hover:bg-white")}>
    <div className="flex items-start justify-between gap-3"><div><strong className="text-emerald-950">{order.code}</strong><p className="mt-1 text-xs text-slate-500">{shortDate(order.createdAt)} · {itemCount} sản phẩm</p></div><ChevronRight className={cn("mt-0.5 size-5 shrink-0", selected ? "text-orange-600" : "text-slate-300")}/></div>
    <p className="mt-3 truncate text-sm font-semibold text-slate-700">{order.items[0]?.name}{order.items.length > 1 ? ` và ${order.items.length - 1} sản phẩm khác` : ""}</p>
    <div className="mt-3 flex items-center justify-between gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${status.className}`}>{status.label}</span><strong className="text-sm text-orange-700">{formatPrice(order.total)}</strong></div>
  </button>
}

function OrderDetail({ order, busy, onCancel, onConfirmReceived }: { order: CustomerOrder; busy: boolean; onCancel: (reason: string) => void; onConfirmReceived: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState("")
  const [receiptOpen, setReceiptOpen] = useState(false)
  const status = statuses[order.status] || { label: order.status, className: "bg-slate-100 text-slate-700" }
  const address = formatAddressParts([order.shippingAddress.addressLine, order.shippingAddress.ward, order.shippingAddress.district, order.shippingAddress.province])

  useEffect(() => { setCancelling(false); setReason(""); setReceiptOpen(false) }, [order._id])

  return <article className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-col justify-between gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:p-6">
      <div><div className="flex flex-wrap items-center gap-3"><h2 className="font-display text-2xl font-bold text-emerald-950">{order.code}</h2><span className={`rounded-full px-3 py-1 text-xs font-black ${status.className}`}>{status.label}</span></div><p className="mt-2 flex items-center gap-2 text-sm text-slate-500"><Clock3 className="size-4"/>{dateTime(order.createdAt)}</p></div>
      <div className="sm:text-right"><p className="text-sm text-slate-500">Tổng thanh toán</p><strong className="text-2xl text-orange-700">{formatPrice(order.total)}</strong><p className="mt-1 text-xs font-bold text-emerald-700">{paymentNames[order.paymentStatus]}</p></div>
    </header>
    <div className="p-5 sm:p-6">
      {order.status !== "cancelled" && <OrderProgress status={order.status}/>}
      <section><h3 className="mb-3 text-sm font-black uppercase tracking-wider text-slate-400">Sản phẩm</h3><div className="divide-y divide-slate-100">{order.items.map(item => <div className="flex items-center gap-4 py-3 first:pt-0" key={`${order._id}-${item.product}`}>{item.image ? <img className="size-14 rounded-xl object-cover" src={item.image} alt={item.name}/> : <div className="grid size-14 shrink-0 place-items-center rounded-xl bg-slate-100"><PackageOpen className="size-5 text-slate-400"/></div>}<div className="min-w-0 flex-1"><h4 className="font-bold text-emerald-950">{item.name}</h4><p className="text-sm text-slate-500">{item.quantity} {item.unit} × {formatPrice(item.price)}</p></div><strong className="text-sm text-slate-800">{formatPrice(item.lineTotal)}</strong></div>)}</div></section>
      <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-3"><Cost label="Tiền hàng" value={formatPrice(order.subtotal)}/><Cost label="Vận chuyển" value={order.shippingFee ? formatPrice(order.shippingFee) : "Chưa phát sinh"}/><Cost label="Thanh toán" value={order.paymentMethod === "cod" ? "Khi nhận hàng" : "Chuyển khoản"}/></div>
      <section className="mt-4 rounded-2xl border border-slate-200 p-4">
        <div><p className="text-xs font-black uppercase tracking-wider text-orange-700">Giao nhận</p><h3 className="mt-1 font-display text-lg font-bold text-emerald-950">Địa chỉ và tiến trình</h3></div>
        <div className="mt-4 grid gap-5 border-t border-slate-200 pt-4 md:grid-cols-2">
          <div className="space-y-4 text-sm"><div className="flex gap-3"><MapPin className="mt-0.5 size-5 shrink-0 text-orange-600"/><p className="leading-6 text-slate-600"><strong className="block text-slate-800">{order.shippingAddress.recipientName} · {order.shippingAddress.phone}</strong>{address}</p></div>{order.shippingProvider && <div className="flex gap-3"><Truck className="size-5 shrink-0 text-orange-600"/><p className="text-slate-600"><strong className="block text-slate-800">{order.shippingProvider}</strong>{order.trackingCode ? `Mã vận đơn: ${order.trackingCode}` : "Đơn vị vận chuyển đang tiếp nhận"}{order.estimatedDeliveryAt && <span className="mt-1 block">Dự kiến: {dateTime(order.estimatedDeliveryAt)}</span>}</p></div>}<div className="flex gap-3"><Banknote className="size-5 shrink-0 text-orange-600"/><p><strong className="block text-slate-800">{paymentNames[order.paymentStatus]}</strong><span className="text-slate-500">{order.paymentMethod === "cod" ? "Thanh toán khi nhận hàng" : "Chuyển khoản ngân hàng"}</span></p></div></div>
          <ol className="space-y-3">{order.timeline.map((item, index) => <li className="flex gap-3 text-sm" key={`${item.at}-${index}`}><span className="mt-1 size-2 shrink-0 rounded-full bg-orange-500"/><div><strong className="text-slate-800">{statuses[item.status]?.label || item.status}</strong>{item.message && <p className="mt-1 leading-5 text-slate-500">{item.message}</p>}<time className="mt-1 block text-xs text-slate-400">{dateTime(item.at)}</time></div></li>)}</ol>
        </div>
      </section>
      {['shipping', 'delivered'].includes(order.status) && !order.customerConfirmedAt && <div className="mt-4 flex flex-col justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center"><div><strong className="text-emerald-950">Bạn đã nhận đủ hàng?</strong><p className="mt-1 text-sm text-emerald-800">Xác nhận để chuyển đơn sang hoàn tất.</p></div><Button className="shrink-0" onClick={() => setReceiptOpen(true)}><CheckCircle2 className="size-5"/>Đã nhận đủ hàng</Button></div>}
      {order.customerConfirmedAt && <p className="mt-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 className="size-5"/>Đã xác nhận nhận hàng lúc {dateTime(order.customerConfirmedAt)}.</p>}
      {order.status === "pending" && (cancelling ? <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 p-4"><label className="text-sm font-bold text-red-900">Lý do hủy đơn<Textarea className="mt-2 bg-white text-slate-900" value={reason} onChange={event => setReason(event.target.value)} placeholder="Ví dụ: Tôi đặt nhầm số lượng sản phẩm"/></label><div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={busy || reason.trim().length < 5} onClick={() => onCancel(reason.trim())}><XCircle className="size-5"/>Xác nhận hủy</Button><Button variant="outline" disabled={busy} onClick={() => { setCancelling(false); setReason("") }}>Giữ lại đơn</Button></div></div> : <Button className="mt-4" variant="ghost" onClick={() => setCancelling(true)}><XCircle className="size-5 text-red-600"/>Hủy đơn hàng</Button>)}
    </div>
    <ConfirmDialog open={receiptOpen} onOpenChange={setReceiptOpen} busy={busy} title="Xác nhận đã nhận đủ hàng?" description="Đơn hàng sẽ được chuyển sang Hoàn tất. Vui lòng chỉ xác nhận khi bạn đã nhận đủ sản phẩm." confirmLabel="Xác nhận đã nhận" onConfirm={() => { setReceiptOpen(false); onConfirmReceived() }}/>
  </article>
}

function OrderProgress({ status }: { status: string }) {
  const normalizedStatus = status === "preparing" ? "confirmed" : status
  const current = Math.max(0, progressSteps.findIndex(step => step.status === normalizedStatus))
  return <ol aria-label="Tiến trình đơn hàng" className="mb-6 grid grid-cols-4 rounded-2xl bg-slate-50 p-3 sm:p-4">{progressSteps.map((step, index) => {
    const done = index < current || normalizedStatus === "delivered"
    const active = index === current && normalizedStatus !== "delivered"
    return <li key={step.status} className="relative flex min-w-0 flex-col items-center text-center"><span className={`absolute left-0 right-1/2 top-3.5 h-0.5 ${index === 0 ? "hidden" : done || active ? "bg-emerald-600" : "bg-slate-200"}`}/><span className={`absolute left-1/2 right-0 top-3.5 h-0.5 ${index === progressSteps.length - 1 ? "hidden" : index < current ? "bg-emerald-600" : "bg-slate-200"}`}/><span className={`relative z-10 grid size-7 place-items-center rounded-full border-2 ${done ? "border-emerald-600 bg-emerald-600 text-white" : active ? "border-orange-500 bg-white text-orange-600" : "border-slate-300 bg-white text-slate-300"}`}>{done ? <Check className="size-4"/> : <span className="size-2 rounded-full bg-current"/>}</span><span className={`mt-2 text-[10px] font-bold leading-tight sm:text-xs ${done || active ? "text-emerald-900" : "text-slate-400"}`}>{step.label}</span></li>
  })}</ol>
}

function Cost({ label, value }: { label: string; value: string }) { return <p><span className="block text-xs text-slate-500">{label}</span><strong className="mt-1 block text-sm text-slate-800">{value}</strong></p> }
function Empty() { return <div className="rounded-3xl border border-dashed border-slate-300 bg-white py-16 text-center"><PackageOpen className="mx-auto size-14 text-slate-300"/><h2 className="mt-4 font-display text-2xl font-bold text-emerald-950">Chưa có đơn hàng</h2><p className="mt-2 text-slate-600">Các sản phẩm có giá niêm yết có thể đặt trực tiếp.</p><Button asChild className="mt-6"><Link to="/san-pham">Xem sản phẩm</Link></Button></div> }
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
const shortDate = (value: string) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value))
function Loading() { return <div className="grid min-h-60 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> }
function ErrorText({ error }: { error: Error }) { return <p role="alert" className="mt-4 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{error.message}</p> }
