import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, ShieldCheck, Trash2 } from "lucide-react"
import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { customerClient } from "@/lib/customer-client"

const labels: Record<string, string> = { submitted: "Đã tiếp nhận", reviewing: "Đang xem xét", approved: "Đã chấp thuận", rejected: "Từ chối", completed: "Đã hoàn tất", cancelled: "Đã hủy" }

export function PrivacyCard() {
  const [params] = useSearchParams()
  const linkedId = params.get("privacyRequestId")
  const client = useQueryClient(); const toast = useToast(); const [reason, setReason] = useState("")
  const requests = useQuery({ queryKey: ["customer", "privacy-requests"], queryFn: customerClient.privacyRequests })
  const active = requests.data?.data.find(item => ["submitted", "reviewing", "approved"].includes(item.status))
  const linked = requests.data?.data.find(item => item._id === linkedId)
  const refresh = () => client.invalidateQueries({ queryKey: ["customer", "privacy-requests"] })
  const create = useMutation({ mutationFn: () => customerClient.createDeletionRequest(reason), onSuccess: result => { setReason(""); toast.success(result.message || "Đã gửi yêu cầu"); void refresh() }, onError: err => toast.error(err.message) })
  const cancel = useMutation({ mutationFn: (id: string) => customerClient.cancelPrivacyRequest(id), onSuccess: result => { toast.success(result.message || "Đã hủy yêu cầu"); void refresh() }, onError: err => toast.error(err.message) })
  const download = async () => { try { const blob = await customerClient.exportPersonalData(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `dk-industry-data-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); toast.success("Đã tải bản sao dữ liệu cá nhân.") } catch (err) { toast.error(err instanceof Error ? err.message : "Không thể xuất dữ liệu") } }
  if (linkedId) return <article className="rounded-3xl border border-slate-200 bg-white p-7"><h2 className="font-display text-2xl font-bold text-emerald-950">Yêu cầu xóa tài khoản</h2>{requests.isLoading ? <p className="mt-4">Đang tải...</p> : linked ? <div className="mt-4 space-y-3"><p className="font-bold">{labels[linked.status]}</p><p>{new Date(linked.createdAt).toLocaleString("vi-VN")}</p><p className="whitespace-pre-wrap">{linked.reason}</p>{linked.resolution && <p className="whitespace-pre-wrap">Phản hồi: {linked.resolution}</p>}</div> : <p role="alert" className="mt-4 text-red-700">{requests.error?.message || "Không tìm thấy yêu cầu hoặc bạn không có quyền xem."}</p>}</article>
  return <article className="rounded-3xl border border-slate-200 bg-white p-7">
    <div className="flex items-start gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-800"><ShieldCheck className="size-6"/></span><div><h2 className="font-display text-2xl font-bold text-emerald-950">Dữ liệu và quyền riêng tư</h2><p className="mt-2 text-sm leading-6 text-slate-600">Tải bản sao dữ liệu của bạn hoặc gửi yêu cầu xóa tài khoản. Dữ liệu giao dịch có thể cần được giữ lại theo nghĩa vụ kế toán và pháp luật.</p></div></div>
    <Button variant="outline" className="mt-5" onClick={() => void download()}><Download className="size-4"/>Xuất dữ liệu cá nhân</Button><div className="my-6 border-t"/>
    {active ? <div className="rounded-2xl bg-amber-50 p-4"><p className="font-bold text-amber-900">Yêu cầu xóa: {labels[active.status]}</p><p className="mt-2 text-sm text-amber-800">Gửi lúc {new Date(active.createdAt).toLocaleString("vi-VN")}</p>{active.resolution && <p className="mt-2 text-sm text-amber-800">Phản hồi: {active.resolution}</p>}{["submitted", "reviewing"].includes(active.status) && <Button className="mt-4" size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(active._id)}>Hủy yêu cầu</Button>}</div> : <div><label className="text-sm font-bold text-emerald-950" htmlFor="deletion-reason">Lý do yêu cầu xóa tài khoản</label><Textarea id="deletion-reason" className="mt-2" maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Mô tả lý do và dữ liệu bạn muốn xóa..."/><Button className="mt-3" variant="destructive" disabled={reason.trim().length < 10 || create.isPending} onClick={() => create.mutate()}><Trash2 className="size-4"/>{create.isPending ? "Đang gửi..." : "Gửi yêu cầu xóa tài khoản"}</Button></div>}
  </article>
}
