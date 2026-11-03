import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, RefreshCw, ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { AdminShell } from "@/components/admin/admin-shell"
import { Pagination } from "@/components/pagination"
import { WorkspaceModal } from "@/components/workspace-modal"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { usePageMeta } from "@/hooks/use-page-meta"
import { adminClient } from "@/lib/admin-client"
import type { AdminPrivacyRequest } from "@/types/admin"

const statusNames: Record<string, string> = { submitted: "Đã tiếp nhận", reviewing: "Đang xem xét", approved: "Đã chấp thuận", rejected: "Từ chối", completed: "Đã hoàn tất", cancelled: "Khách đã hủy" }

function RequestCard({ item }: { item: AdminPrivacyRequest }) {
  const queryClient = useQueryClient(); const [status, setStatus] = useState(item.status); const [resolution, setResolution] = useState(item.resolution || ""); const [error, setError] = useState("")
  const update = useMutation({ mutationFn: () => adminClient.updatePrivacyRequest(item._id, { status, resolution }), onSuccess: () => { setError(""); void queryClient.invalidateQueries({ queryKey: ["admin", "privacy"] }) }, onError: err => setError(err.message) })
  const closed = ["cancelled", "completed"].includes(item.status)
  return <article className="rounded-3xl border bg-white p-6 shadow-sm"><div className="flex flex-col justify-between gap-3 md:flex-row"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-bold text-emerald-950">{item.customer?.name || "Tài khoản không còn tồn tại"}</h2><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">{statusNames[item.status]}</span></div><p className="mt-1 text-sm text-slate-500">{item.customer?.email} · {item.customer?.phone || "Chưa có SĐT"} · {new Date(item.createdAt).toLocaleString("vi-VN")}</p></div></div><div className="mt-5 rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black uppercase tracking-wider text-slate-500">Lý do của khách hàng</p><p className="mt-2 whitespace-pre-wrap text-slate-700">{item.reason}</p></div><div className="mt-5 grid gap-4 md:grid-cols-[220px_1fr]"><label className="text-sm font-bold text-slate-700">Trạng thái<span className="mt-2 block"><Select disabled={closed} ariaLabel="Trạng thái yêu cầu quyền riêng tư" value={status} onChange={value => setStatus(value as AdminPrivacyRequest["status"])} options={["submitted", "reviewing", "approved", "rejected", "completed"].map(value => ({ value, label: statusNames[value] }))}/></span></label><label className="text-sm font-bold text-slate-700">Kết quả/Ghi chú xử lý<Textarea className="mt-2" disabled={closed} maxLength={3000} value={resolution} onChange={event => setResolution(event.target.value)} placeholder="Nêu dữ liệu đã xóa, dữ liệu phải giữ lại và căn cứ..."/></label></div>{!closed && <Button className="mt-4" disabled={update.isPending || (["rejected", "completed"].includes(status) && resolution.trim().length < 10)} onClick={() => update.mutate()}>{update.isPending ? "Đang lưu..." : "Lưu kết quả xử lý"}</Button>}{error && <p role="alert" className="mt-3 text-sm font-semibold text-red-700">{error}</p>}</article>
}

export function AdminPrivacyPage() {
  const [params, setParams] = useSearchParams()
  const linkedId = params.get("privacyRequestId") || ""
  usePageMeta("Yêu cầu quyền riêng tư", "Tiếp nhận và xử lý yêu cầu dữ liệu cá nhân của khách hàng.")
  const [status, setStatus] = useState(""); const [page, setPage] = useState(1); const [selected, setSelected] = useState<AdminPrivacyRequest | null>(null)
  const requests = useQuery({ queryKey: ["admin", "privacy", status, page, linkedId], queryFn: () => adminClient.privacyRequests(status, page, linkedId) })
  useEffect(() => {
    if (linkedId) setSelected(requests.data?.data.items.find(item => item._id === linkedId) || null)
  }, [linkedId, requests.data])
  const items = requests.data?.data.items || []
  return <AdminShell title="Quyền riêng tư" description="Theo dõi yêu cầu xóa tài khoản. Không xóa chứng từ giao dịch trước khi xác định thời hạn lưu trữ bắt buộc.">
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-emerald-950 px-5 py-5 text-white sm:px-6"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-orange-300 ring-1 ring-white/15"><ShieldCheck className="size-5"/></span><div><h2 className="font-display text-xl font-bold">Yêu cầu quyền riêng tư</h2><p className="mt-1 text-sm text-emerald-100/70">Chọn một yêu cầu để xem và xử lý trong cửa sổ riêng.</p></div></div><div className="flex items-center gap-2"><span className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-emerald-950">{requests.data?.data.total || 0} yêu cầu</span><button type="button" onClick={() => void requests.refetch()} className="grid size-10 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15 hover:bg-white/20" aria-label="Làm mới"><RefreshCw className={`size-4 ${requests.isFetching ? "animate-spin" : ""}`}/></button></div></div>
      <div className="border-b p-4 sm:flex sm:items-center sm:justify-between"><p className="mb-3 text-sm font-semibold text-slate-500 sm:mb-0">Danh sách được xếp gọn để dễ rà soát</p><Select className="sm:w-56" ariaLabel="Lọc trạng thái yêu cầu" value={status} onChange={value => { setStatus(value); setPage(1) }} options={[{ value: "", label: "Tất cả trạng thái" }, ...Object.entries(statusNames).map(([value, label]) => ({ value, label }))]}/></div>
      <div className="hidden grid-cols-[1.2fr_1fr_180px_52px] gap-4 border-b bg-slate-50 px-5 py-3 text-xs font-black uppercase tracking-wider text-slate-500 md:grid"><span>Khách hàng</span><span>Ngày gửi</span><span>Trạng thái</span><span/></div>
      <div className="max-h-[min(58vh,620px)] min-h-64 overflow-y-auto">{items.map(item => <button type="button" key={item._id} onClick={() => setSelected(item)} className="group grid w-full grid-cols-[1fr_auto] items-center gap-3 border-b border-l-4 border-b-slate-100 border-l-orange-400 px-5 py-4 text-left transition last:border-b-0 hover:bg-orange-50/60 md:grid-cols-[1.2fr_1fr_180px_52px]"><div className="min-w-0"><strong className="block truncate text-emerald-950">{item.customer?.name || "Tài khoản không còn tồn tại"}</strong><span className="mt-1 block truncate text-sm text-slate-500">{item.customer?.email || "Không có email"}</span></div><span className="text-sm text-slate-500">{new Date(item.createdAt).toLocaleString("vi-VN")}</span><span className="w-fit rounded-full bg-amber-50 px-3 py-1 text-xs font-black text-amber-800">{statusNames[item.status]}</span><span className="grid size-9 place-items-center rounded-xl bg-orange-50 text-orange-600 group-hover:bg-orange-600 group-hover:text-white"><Eye className="size-4"/></span></button>)}{requests.isLoading && <p className="p-10 text-center">Đang tải...</p>}{requests.error && <p role="alert" className="m-5 rounded-xl bg-red-50 p-4 text-red-700">{requests.error.message}</p>}{!requests.isLoading && !items.length && <p className="p-10 text-center text-slate-500">Chưa có yêu cầu phù hợp.</p>}</div>
      <div className="border-t px-4 py-3"><Pagination page={requests.data?.data.page || page} pages={requests.data?.data.pages || 1} onChange={setPage}/></div>
    </section>
    <WorkspaceModal open={Boolean(selected)} onOpenChange={open => { if (!open) { setSelected(null); if (linkedId) setParams({}) } }} width="medium" eyebrow="Xử lý dữ liệu" title={selected?.customer?.name || "Yêu cầu quyền riêng tư"} description={selected ? `${statusNames[selected.status]} · ${new Date(selected.createdAt).toLocaleString("vi-VN")}` : undefined}>{selected && <RequestCard item={selected}/>}</WorkspaceModal>
  </AdminShell>
}
