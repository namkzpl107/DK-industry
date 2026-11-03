import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft, CheckCircle2, Clock3, Download, Eye, FileCog, FileUp, LoaderCircle, Plus, Send, XCircle,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { FormEventHandler, RefObject } from "react"
import { useForm } from "react-hook-form"
import type { UseFormReturn } from "react-hook-form"
import { useSearchParams } from "react-router-dom"
import { z } from "zod"
import { CustomerShell } from "@/components/customer/customer-shell"
import { RequestConversation } from "@/components/customer/request-conversation-realtime"
import { Pagination } from "@/components/pagination"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import { useAuth } from "@/contexts/auth-context"
import { usePageMeta } from "@/hooks/use-page-meta"
import { customerClient } from "@/lib/customer-client"
import { requestStageLabel, requestStageStyle } from "@/lib/simple-status"
import { cn, scrollToPageTop } from "@/lib/utils"
import type { CustomerRequest, RequestAttachment } from "@/types/customer"

const services = ["Tư vấn kỹ thuật", "Gia công cơ khí", "Thi công công nghiệp", "Cung ứng thiết bị"]
const budgets = ["Chưa xác định", "Dưới 100 triệu", "100 - 500 triệu", "500 triệu - 2 tỷ", "Trên 2 tỷ"]
const schema = z.object({
  serviceType: z.string().min(1, "Vui lòng chọn nhu cầu"),
  budget: z.string(),
  message: z.string().trim().max(2000, "Nội dung tối đa 2.000 ký tự"),
  consent: z.boolean().refine(value => value, "Vui lòng đồng ý để chúng tôi liên hệ"),
})
type RequestData = z.infer<typeof schema>
const emptyRequest = (product = ""): RequestData => ({
  serviceType: product ? "Cung ứng thiết bị" : "",
  budget: "Chưa xác định",
  message: product ? `Tôi cần báo giá: ${product}` : "",
  consent: false,
})

function statusView(request: { status: string; latestQuotation?: { status: string } | null }) {
  const revisionRequested = request.status === "reviewing" && request.latestQuotation?.status === "rejected"
  return { label: requestStageLabel(request.status, revisionRequested), className: requestStageStyle(request.status, revisionRequested) }
}
const typeNames: Record<CustomerRequest["requestType"], string> = {
  machining: "Gia công theo yêu cầu",
  product_quote: "Báo giá sản phẩm",
  consulting: "Tư vấn kỹ thuật",
}

export function CustomerRequestsWorkspacePage() {
  usePageMeta("Yêu cầu gia công", "Gửi bản vẽ và theo dõi yêu cầu kỹ thuật.")
  const [params, setParams] = useSearchParams()
  const productId = params.get("productId") || ""
  const productName = params.get("product") || ""
  const queryClient = useQueryClient()
  const toast = useToast()
  const { user } = useAuth()
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState("")
  const [cancellingRequest, setCancellingRequest] = useState<CustomerRequest | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<CustomerRequest | null>(null)
  const [showCreate, setShowCreate] = useState(Boolean(productName))
  const form = useForm<RequestData>({ resolver: zodResolver(schema), defaultValues: emptyRequest(productName) })
  const requests = useQuery({ queryKey: ["customer", "requests"], queryFn: customerClient.requests })
  const activeRequest = selectedRequest
    ? requests.data?.data.find(item => item._id === selectedRequest._id) || selectedRequest
    : null

  useEffect(() => {
    const requestId = params.get("requestId")
    const item = requests.data?.data.find(value => value._id === requestId)
    if (requestId) setSelectedRequest(item || null)
  }, [params, requests.data])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["customer", "requests"] })
    void queryClient.invalidateQueries({ queryKey: ["customer", "summary"] })
  }
  const create = useMutation({
    mutationFn: customerClient.createRequest,
    onSuccess: result => {
      toast.success(`Đã gửi yêu cầu ${result.data.code}. Kỹ thuật sẽ kiểm tra trong giờ làm việc.`, { title: "Gửi yêu cầu thành công" })
      form.reset(emptyRequest())
      setFiles([])
      setShowCreate(false)
      if (fileInput.current) fileInput.current.value = ""
      scrollToPageTop()
      refresh()
    },
    onError: error => toast.error(error.message, { title: "Không thể gửi yêu cầu" }),
  })
  const cancel = useMutation({
    mutationFn: customerClient.cancelRequest,
    onSuccess: result => {
      toast.success(result.message || "Đã hủy yêu cầu")
      setCancellingRequest(null)
      setSelectedRequest(null)
      scrollToPageTop()
      refresh()
    },
    onError: error => toast.error(error.message),
  })

  const submit = form.handleSubmit(data => {
    setFileError("")
    if (files.some(file => !file.name.toLowerCase().endsWith(".pdf"))) {
      setFileError("Chỉ gửi bản vẽ định dạng PDF")
      return
    }
    if (files.length > 5 || files.some(file => file.size > 10 * 1024 * 1024)) {
      setFileError("Tối đa 5 tệp PDF, mỗi tệp không quá 10MB")
      return
    }
    const requestType = data.serviceType === "Cung ứng thiết bị" ? "product_quote" : data.serviceType === "Tư vấn kỹ thuật" ? "consulting" : "machining"
    const title = (productName && data.serviceType === "Cung ứng thiết bị" ? `Báo giá ${productName}` : data.serviceType).slice(0, 200)
    const note = data.message.trim()
    const description = (note.length >= 10 ? note : `Tôi cần ${data.serviceType.toLowerCase()}.${note ? ` ${note}` : ""}`).slice(0, 5000)
    const body = new FormData()
    body.append("requestType", requestType)
    body.append("title", title)
    body.append("description", description)
    if (data.budget) body.append("budget", data.budget)
    if (productId) body.append("productId", productId)
    files.forEach(file => body.append("attachments", file))
    create.mutate(body)
  })

  const download = async (request: CustomerRequest, attachment: RequestAttachment) => {
    try {
      const blob = await customerClient.downloadAttachment(request._id, attachment._id)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = attachment.originalName
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Không thể tải tệp")
    }
  }

  if (requests.error) return <CustomerShell title="Yêu cầu gia công & báo giá" description="Không thể tải lịch sử yêu cầu."><p role="alert" className="rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{requests.error.message}</p></CustomerShell>

  const items = requests.data?.data || []
  const clearRequestParam = () => {
    if (!params.get("requestId")) return
    const next = new URLSearchParams(params)
    next.delete("requestId")
    setParams(next, { replace: true })
  }
  const backToList = () => { setShowCreate(false); setSelectedRequest(null); clearRequestParam(); scrollToPageTop() }
  const openRequest = (request: CustomerRequest) => { setShowCreate(false); setSelectedRequest(request); scrollToPageTop() }
  const startCreate = () => { setSelectedRequest(null); clearRequestParam(); setShowCreate(true); scrollToPageTop() }
  return <CustomerShell title="Yêu cầu gia công & báo giá" description="Gửi một lần. Theo dõi trạng thái, báo giá và tin nhắn trên cùng một trang.">
    {activeRequest
      ? <CustomerRequestDetail request={activeRequest} onBack={backToList} onDownload={attachment => void download(activeRequest, attachment)} onCancel={() => setCancellingRequest(activeRequest)}/>
      : params.get("requestId") && !requests.isLoading
        ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">Không tìm thấy yêu cầu hoặc bạn không có quyền xem.</p>
      : showCreate
        ? <CreateRequestForm form={form} account={{ name: user?.name || "", phone: user?.phone || "", email: user?.email || "" }} files={files} fileError={fileError} fileInput={fileInput} busy={create.isPending} onFiles={next => { const pdfs = next.filter(file => file.name.toLowerCase().endsWith(".pdf")); setFileError(pdfs.length === next.length ? "" : "Chỉ gửi bản vẽ định dạng PDF"); setFiles(pdfs) }} onSubmit={submit} onBack={backToList}/>
        : <RequestList requests={items} loading={requests.isLoading} onCreate={startCreate} onSelect={openRequest}/>}
    <ConfirmDialog open={Boolean(cancellingRequest)} title="Hủy yêu cầu này?" description={cancellingRequest ? `Yêu cầu ${cancellingRequest.code} sẽ được chuyển sang trạng thái đã hủy và không tiếp tục xử lý.` : ""} confirmLabel="Hủy yêu cầu" destructive busy={cancel.isPending} onOpenChange={open => { if (!open) setCancellingRequest(null) }} onConfirm={() => { if (cancellingRequest) cancel.mutate(cancellingRequest._id) }}/>
  </CustomerShell>
}

const requestsPerPage = 7

function RequestList({ requests, loading, onCreate, onSelect }: { requests: CustomerRequest[]; loading: boolean; onCreate: () => void; onSelect: (request: CustomerRequest) => void }) {
  const [page, setPage] = useState(1)
  const openCount = requests.filter(item => !["accepted", "rejected", "cancelled"].includes(item.status)).length
  const pages = Math.max(1, Math.ceil(requests.length / requestsPerPage))
  const currentPage = Math.min(page, pages)
  const visible = requests.slice((currentPage - 1) * requestsPerPage, currentPage * requestsPerPage)
  return <section className="overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-300 px-4 py-4 sm:px-5">
      <div><h2 className="font-display text-xl font-bold text-slate-950">Yêu cầu gia công</h2><p className="mt-1 text-sm text-slate-600">{requests.length} yêu cầu · {openCount} đang xử lý</p></div>
      <Button onClick={onCreate}><Plus className="size-4"/>Tạo yêu cầu mới</Button>
    </header>
    {loading ? <Loading/> : !requests.length ? <div className="grid min-h-80 place-items-center px-6 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-orange-50 text-orange-600"><FileCog className="size-7"/></span><p className="mt-4 font-bold text-emerald-950">Bạn chưa có yêu cầu nào</p><p className="mt-1 text-sm text-slate-500">Tạo hồ sơ đầu tiên để gửi thông số và nhận báo giá.</p><Button className="mt-5" onClick={onCreate}><Plus className="size-4"/>Tạo yêu cầu</Button></div></div> : <>
      <div className="hidden grid-cols-[minmax(0,1.35fr)_minmax(160px,.7fr)_140px_210px_90px] gap-5 border-b border-slate-200 bg-slate-50/80 px-6 py-3 text-[11px] font-black uppercase tracking-[.12em] text-slate-500 lg:grid"><span>Yêu cầu</span><span>Loại</span><span>Ngày gửi</span><span>Trạng thái</span><span className="text-right">Thao tác</span></div>
      <div>{visible.map(request => {
        const status = statusView(request)
        return <button type="button" key={request._id} onClick={() => onSelect(request)} className="group block w-full border-b border-slate-100 px-5 py-5 text-left transition last:border-b-0 hover:bg-orange-50/50 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(160px,.7fr)_140px_210px_90px] lg:items-center lg:gap-5 lg:px-6 lg:py-4">
          <div className="min-w-0"><span className="text-xs font-black uppercase tracking-wider text-orange-700">{request.code}</span><strong className="mt-1 block truncate text-base text-emerald-950">{request.title}</strong><div className="mt-3 flex flex-wrap items-center gap-2 lg:hidden"><span className="text-xs text-slate-500">{typeNames[request.requestType]}</span><span className="text-slate-300">•</span><span className="text-xs text-slate-500">{date(request.createdAt)}</span><span className={cn("rounded-full px-2.5 py-1 text-xs font-black ring-1 ring-inset", status.className)}>{status.label}</span></div></div>
          <span className="hidden truncate text-sm text-slate-600 lg:block">{typeNames[request.requestType]}</span><span className="hidden text-sm text-slate-500 lg:block">{date(request.createdAt)}</span>
          <div className="hidden flex-wrap items-center gap-2 lg:flex"><span className={cn("rounded-full px-3 py-1.5 text-xs font-black ring-1 ring-inset", status.className)}>{status.label}</span>{request.latestQuotation?.status === "sent" && <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-black text-orange-800">Báo giá mới</span>}{Boolean(request.unreadCount) && <span className="rounded-full bg-red-600 px-2 py-1 text-xs font-black text-white">{request.unreadCount} mới</span>}</div>
          <span className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-orange-50 px-3 text-sm font-bold text-orange-700 transition group-hover:bg-orange-600 group-hover:text-white lg:mt-0 lg:justify-self-end">Mở<Eye className="size-4"/></span>
        </button>
      })}</div>
      {pages > 1 && <div className="border-t border-slate-200 px-4 py-3"><Pagination page={currentPage} pages={pages} onChange={nextPage => { setPage(nextPage); scrollToPageTop() }}/></div>}
    </>}
  </section>
}

interface CreateRequestFormProps {
  form: UseFormReturn<RequestData>
  account: { name: string; phone: string; email: string }
  files: File[]
  fileError: string
  fileInput: RefObject<HTMLInputElement | null>
  busy: boolean
  onFiles: (files: File[]) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onBack: () => void
}

function CreateRequestForm({ form, account, files, fileError, fileInput, busy, onFiles, onSubmit, onBack }: CreateRequestFormProps) {
  return <div className="space-y-3">
    <Button type="button" variant="outline" onClick={onBack}><ArrowLeft className="size-4"/>Danh sách</Button>
    <section className="overflow-hidden rounded-panel border border-slate-200 bg-white shadow-sm lg:grid lg:grid-cols-[.8fr_1.2fr]">
    <div className="hidden bg-emerald-950 p-10 text-white lg:block">
      <p className="mb-5 text-xs font-bold uppercase tracking-[.2em] text-orange-400">Yêu cầu tư vấn</p>
      <h2 className="font-display text-4xl font-semibold leading-tight">Cho chúng tôi biết bài toán của bạn.</h2>
      <p className="mt-5 text-base leading-7 text-emerald-50/70">Kỹ sư Cơ khí Đăng Khoa sẽ phân tích yêu cầu và phản hồi qua email hoặc điện thoại trong vòng 2 giờ làm việc.</p>
      <ul className="mt-9 space-y-4 text-sm font-semibold">{["Tư vấn hoàn toàn miễn phí", "Bảo mật thông tin dự án", "Giải pháp đúng nhu cầu"].map(item => <li className="flex items-center gap-3" key={item}><CheckCircle2 className="size-5 text-orange-400"/>{item}</li>)}</ul>
    </div>
    <form className="p-6 sm:p-10" onSubmit={onSubmit} noValidate>
      <div className="mb-7 lg:hidden"><h2 className="font-display text-2xl font-bold text-emerald-950">Yêu cầu tư vấn</h2><p className="mt-2 text-sm leading-6 text-slate-600">Điền thông tin, chúng tôi sẽ gọi lại trong vòng 2 giờ làm việc.</p></div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Họ và tên"><Input value={account.name} readOnly autoComplete="name"/></Field>
        <Field label="Số điện thoại"><Input value={account.phone} readOnly inputMode="tel" autoComplete="tel"/></Field>
      </div>
      <Field label="Email nhận phản hồi"><Input value={account.email} readOnly type="email" autoComplete="email"/></Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Bạn cần hỗ trợ gì?" error={form.formState.errors.serviceType?.message}><Select ariaLabel="Dịch vụ cần hỗ trợ" value={form.watch("serviceType")} onChange={value => form.setValue("serviceType", value, { shouldDirty: true, shouldValidate: true })} options={["Chọn dịch vụ", ...services].map((label, index) => ({ value: index ? label : "", label }))}/></Field>
        <Field label="Ngân sách dự kiến"><Select ariaLabel="Ngân sách dự kiến" value={form.watch("budget")} onChange={value => form.setValue("budget", value, { shouldDirty: true })} options={budgets.map(value => ({ value, label: value }))}/></Field>
      </div>
      <Field label="Mô tả yêu cầu" error={form.formState.errors.message?.message}><Textarea placeholder="Loại công trình, thông số, số lượng, tiến độ mong muốn..." {...form.register("message")}/></Field>
      <div className="mb-5">
        <p className="mb-2 text-sm font-bold text-slate-700">Bản vẽ PDF</p>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600 hover:border-orange-400"><FileUp className="size-4 shrink-0 text-orange-600"/><span>Chỉ nhận PDF · 5 tệp × 10MB</span><input ref={fileInput} className="sr-only" type="file" multiple accept="application/pdf,.pdf" onChange={event => onFiles(Array.from(event.target.files || []))}/></label>
        {files.length > 0 && <ul className="mt-2 space-y-1 text-sm font-semibold text-slate-700">{files.map(file => <li key={`${file.name}-${file.size}`} className="truncate">{file.name}</li>)}</ul>}
        {fileError && <p role="alert" className="mt-1.5 text-sm font-medium text-red-600">{fileError}</p>}
      </div>
      <label className="mb-5 flex items-start gap-3 text-sm leading-6 text-slate-600"><input className="mt-1 size-5 shrink-0 accent-orange-600" type="checkbox" {...form.register("consent")}/><span>Tôi đồng ý để Cơ khí Đăng Khoa sử dụng thông tin trên nhằm liên hệ tư vấn và xử lý yêu cầu.{form.formState.errors.consent?.message && <strong className="block text-red-600">{form.formState.errors.consent.message}</strong>}</span></label>
      <Button className="mt-2 w-full" size="lg" disabled={busy}>{busy ? <><LoaderCircle className="size-5 animate-spin"/>Đang gửi...</> : <>Gửi yêu cầu <Send className="size-5"/></>}</Button>
    </form>
    </section>
  </div>
}

function CustomerRequestDetail({ request, onBack, onDownload, onCancel }: { request: CustomerRequest; onBack: () => void; onDownload: (attachment: RequestAttachment) => void; onCancel: () => void }) {
  const status = statusView(request)
  const facts = [
    request.material && ["Vật liệu", request.material],
    request.quantity && ["Số lượng", String(request.quantity)],
    request.dimensions && ["Kích thước", request.dimensions],
    request.desiredDate && ["Ngày mong muốn", date(request.desiredDate)],
    request.budget && ["Ngân sách", request.budget],
    request.productSnapshot?.name && ["Sản phẩm", request.productSnapshot.name],
  ].filter(Boolean) as string[][]
  return <div className="space-y-4">
    <section className="overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <Button type="button" variant="ghost" className="-ml-3 mb-2" onClick={onBack}><ArrowLeft className="size-4"/>Danh sách</Button>
          <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-bold tracking-wide text-orange-700">{request.code}</span><span className={cn("rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset", status.className)}>{status.label}</span>{Boolean(request.unreadCount) && <span className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold text-white">{request.unreadCount} tin mới</span>}</div>
          <h2 className="mt-1 font-display text-2xl font-bold text-slate-950">{request.title}</h2>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500"><Clock3 className="size-4"/>{typeNames[request.requestType]} · {dateTime(request.createdAt)}</p>
        </div>
        {["submitted", "need_more_info"].includes(request.status) && <Button size="sm" variant="outline" onClick={onCancel}><XCircle className="size-4 text-red-600"/>Hủy yêu cầu</Button>}
      </header>
      <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(240px,.8fr)]">
        <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{request.description}</p>
        <div>
          {facts.length > 0 && <dl className="grid grid-cols-2 gap-3">{facts.map(([label, value]) => <div key={label}><dt className="text-[11px] font-bold uppercase tracking-[.12em] text-slate-400">{label}</dt><dd className="mt-0.5 text-sm font-semibold text-slate-950">{value}</dd></div>)}</dl>}
          <div className={facts.length ? "mt-3 border-t border-slate-100 pt-3" : undefined}><p className="text-[11px] font-bold uppercase tracking-[.12em] text-slate-400">Tài liệu</p>{request.attachments.length ? <div className="mt-2 flex flex-wrap gap-2">{request.attachments.map(attachment => <button className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-slate-50 px-3 text-sm font-semibold text-slate-700 hover:bg-orange-50 hover:text-orange-800" key={attachment._id} onClick={() => onDownload(attachment)}><Download className="size-4"/>{attachment.originalName}</button>)}</div> : <p className="mt-1 text-sm text-slate-500">Không có tệp đính kèm.</p>}</div>
        </div>
      </div>
    </section>
    <RequestConversation requestId={request._id} mode="workspace"/>
  </div>
}
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <label className="mb-5 block text-sm font-bold text-slate-700"><span className="mb-2 block">{label}</span>{children}{error && <span className="mt-1.5 block text-sm font-medium text-red-600">{error}</span>}</label>
}
const date = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date(value))
const dateTime = (value: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
function Loading() { return <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-8 animate-spin text-orange-600"/></div> }
