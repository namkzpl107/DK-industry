import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, CheckCheck, Headphones, LoaderCircle, MessageCircleMore, Minus, Send, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useAuth } from "@/contexts/auth-context"
import { company } from "@/config/company"
import { SupportQuickActions } from "@/components/support-quick-actions"
import { supportClient } from "@/lib/support-client"
import { acquireSupportSocket, releaseSupportSocket, storeSupportSocketToken, supportSocket } from "@/lib/support-socket"
import { cn } from "@/lib/utils"
import type { SupportMessage, SupportSession } from "@/types/support"

type SessionResult = { success: boolean; data: SupportSession | null; message?: string }
type SendVariables = { content: string; clientMessageId: string }

function merge(messages: SupportMessage[], incoming: SupportMessage) {
  const values = messages.filter(item => item._id !== incoming._id && (!incoming.clientMessageId || item.clientMessageId !== incoming.clientMessageId))
  return [...values, incoming].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

export function SupportChatWidget() {
  const { user, ready } = useAuth()
  const client = useQueryClient()
  const listRef = useRef<HTMLDivElement>(null)
  const [params] = useSearchParams()
  const linkedConversationId = params.get("supportConversationId") || ""
  const [open, setOpen] = useState(params.get("support") === "open")
  useEffect(() => { if (params.get("support") === "open") setOpen(true) }, [params])
  const [content, setContent] = useState("")
  const [liveUnread, setLiveUnread] = useState(0)
  const [aiStatus, setAiStatus] = useState<"idle" | "thinking" | "handoff">("idle")
  const [guestMessages, setGuestMessages] = useState<SupportMessage[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const queryKey = useMemo(() => ["support", "session", user?.id || "guest", linkedConversationId] as const, [user?.id, linkedConversationId])
  const session = useQuery({ queryKey, queryFn: () => supportClient.session(linkedConversationId), enabled: ready && user?.role === 'customer', staleTime: 30_000, meta: { suppressGlobalLoading: true } })
  const conversationId = session.data?.data?.conversation._id
  const messages = user?.role === 'customer' ? (session.data?.data?.messages || []) : guestMessages
  const unread = open ? 0 : Math.max(liveUnread, session.data?.data?.conversation.unreadByCustomer || 0)

  const updateSession = useCallback((updater: (value: SupportSession) => SupportSession) => client.setQueryData<SessionResult>(queryKey, current => current?.data ? { ...current, data: updater(current.data) } : current), [client, queryKey])

  useEffect(() => { setGuestMessages([]); setAiStatus('idle') }, [user?.id])
  useEffect(() => {
    if (ready && !user) void supportClient.clearGuestSession().catch(() => undefined)
  }, [ready, user])
  useEffect(() => { storeSupportSocketToken(session.data?.data?.socketToken) }, [session.data?.data?.socketToken])
  useEffect(() => {
    if (!conversationId) return
    const socket = acquireSupportSocket()
    const join = () => socket.emit("support:join", conversationId, (result: { ok: boolean }) => { if (result.ok && open) socket.emit("support:read", conversationId) })
    const onMessage = (payload: { conversationId: string; message: SupportMessage }) => {
      if (payload.conversationId !== conversationId) return
      updateSession(value => ({ ...value, messages: merge(value.messages, payload.message) }))
      if (payload.message.senderRole === 'system' && payload.message.ai) setAiStatus(payload.message.ai.needsHuman ? 'handoff' : 'idle')
      const fromStaff = ['staff', 'admin', 'system'].includes(payload.message.senderRole)
      if (fromStaff && !open) setLiveUnread(value => value + 1)
      if (open) socket.emit("support:read", conversationId)
    }
    const onRead = (payload: { conversationId: string; reader: string; readAt: string }) => {
      if (payload.conversationId !== conversationId || payload.reader !== 'staff') return
      updateSession(value => ({ ...value, messages: value.messages.map(message => ['guest', 'customer'].includes(message.senderRole) ? { ...message, readAt: payload.readAt } : message) }))
    }
    const onAiStatus = (payload: { conversationId: string; status: "idle" | "thinking" | "handoff" }) => {
      if (payload.conversationId === conversationId) setAiStatus(payload.status)
    }
    socket.on("connect", join); socket.on("support:message", onMessage); socket.on("support:read", onRead); socket.on("support:ai-status", onAiStatus)
    if (socket.connected) join()
    return () => { socket.off("connect", join); socket.off("support:message", onMessage); socket.off("support:read", onRead); socket.off("support:ai-status", onAiStatus); releaseSupportSocket() }
  }, [conversationId, open, updateSession])

  useEffect(() => {
    if (!open) return
    setLiveUnread(0)
    updateSession(value => ({ ...value, conversation: { ...value.conversation, unreadByCustomer: 0 } }))
    if (conversationId) supportSocket.emit("support:read", conversationId)
    const timer = setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }), 50)
    return () => clearTimeout(timer)
  }, [open, conversationId, messages.length, updateSession])

  const send = useMutation({
    mutationKey: ['support', 'send'],
    meta: { suppressGlobalLoading: true },
    mutationFn: async (variables: SendVariables) => {
      if (!user) {
        const result = await supportClient.guestAi({ content: variables.content, history: guestMessages.map(({ senderRole, content: messageContent }) => ({ senderRole, content: messageContent })) })
        return { mode: 'guest' as const, result }
      }
      return { mode: 'customer' as const, result: await supportClient.send(variables, linkedConversationId) }
    },
    onMutate: variables => {
      setContent("")
      if (!user) {
        setGuestMessages(value => merge(value, { _id: `pending:${variables.clientMessageId}`, conversation: 'guest-session', senderRole: 'guest', clientMessageId: variables.clientMessageId, content: variables.content, createdAt: new Date().toISOString() }))
        setAiStatus('thinking')
        return
      }
      if (!conversationId) return
      updateSession(value => ({ ...value, messages: merge(value.messages, { _id: `pending:${variables.clientMessageId}`, conversation: conversationId, senderRole: "customer", clientMessageId: variables.clientMessageId, content: variables.content, createdAt: new Date().toISOString(), deliveryStatus: "sending" }) }))
    },
    onSuccess: (response, variables) => {
      if (response.mode === 'guest') {
        const now = new Date().toISOString()
        const sent: SupportMessage = { _id: `guest:${variables.clientMessageId}`, conversation: 'guest-session', senderRole: 'guest', clientMessageId: variables.clientMessageId, content: variables.content, createdAt: now }
        const ai: SupportMessage = { _id: `ai:${variables.clientMessageId}`, conversation: 'guest-session', senderRole: 'system', content: response.result.data.answer, createdAt: new Date().toISOString(), ai: { provider: response.result.data.fallback ? 'fallback' : 'groq', needsHuman: response.result.data.needsHuman, reason: response.result.data.reason } }
        setGuestMessages(value => merge(merge(value.filter(item => item.clientMessageId !== variables.clientMessageId), sent), ai))
        setAiStatus(response.result.data.needsHuman ? 'handoff' : 'idle')
        return
      }
      const result = response.result
      storeSupportSocketToken(result.data.socketToken)
      const current = client.getQueryData<SessionResult>(queryKey)?.data
      client.setQueryData<SessionResult>(queryKey, { success: true, data: { conversation: result.data.conversation, messages: merge((current?.messages || []).filter(item => item.clientMessageId !== variables.clientMessageId), result.data.message), page: current?.page || { hasMore: false, nextCursor: null }, socketToken: result.data.socketToken || current?.socketToken } })
      setAiStatus("thinking")
      window.setTimeout(async () => {
        await client.invalidateQueries({ queryKey })
        const refreshed = client.getQueryData<SessionResult>(queryKey)?.data
        const latest = refreshed?.messages.at(-1)
        if (latest?.senderRole === 'system' && latest.ai) setAiStatus(latest.ai.needsHuman ? 'handoff' : 'idle')
      }, 2500)
    },
    onError: (_, variables) => {
      if (!user) {
        setGuestMessages(value => value.map(item => item.clientMessageId === variables.clientMessageId ? { ...item, deliveryStatus: "failed" } : item))
        setContent(current => current || variables.content)
        setAiStatus('idle')
        return
      }
      updateSession(value => ({ ...value, messages: value.messages.map(item => item.clientMessageId === variables.clientMessageId ? { ...item, deliveryStatus: "failed" } : item) }))
      setContent(current => current || variables.content)
    },
  })

  if (!ready || ['staff', 'admin'].includes(user?.role || '')) return null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!content.trim()) return
    send.mutate({ content: content.trim(), clientMessageId: crypto.randomUUID() })
  }
  const sendQuickAction = (message: string) => {
    if (send.isPending) return
    send.mutate({ content: message, clientMessageId: crypto.randomUUID() })
  }
  const loadOlder = async () => {
    const page = session.data?.data?.page
    if (!page?.hasMore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await supportClient.messages(page.nextCursor, linkedConversationId)
      updateSession(value => ({ ...value, messages: [...result.data.items, ...value.messages].filter((item, index, all) => all.findIndex(candidate => candidate._id === item._id) === index), page: { hasMore: result.data.hasMore, nextCursor: result.data.nextCursor } }))
    } finally { setLoadingOlder(false) }
  }

  return <div className="support-dock">
    {open && <section role="dialog" aria-label="Hỗ trợ khách hàng" className="mb-3 flex h-[min(660px,calc(100vh-7rem))] w-[min(400px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl border border-emerald-200 bg-white shadow-2xl shadow-emerald-950/25">
      <header className="relative flex items-center justify-between overflow-hidden bg-emerald-950 px-4 py-3.5 text-white after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-orange-500">
        <div className="relative flex min-w-0 items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-orange-500 text-white shadow-lg shadow-emerald-950/30"><Headphones className="size-5"/></span><div className="min-w-0"><strong className="block truncate">Chăm sóc khách hàng</strong><span className="block text-xs text-emerald-100">AI hỗ trợ ngay · Nhân viên tiếp nhận sau</span></div></div>
        <div className="flex"><button className="grid size-9 place-items-center rounded-full hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Thu nhỏ"><Minus className="size-5"/></button><button className="grid size-9 place-items-center rounded-full hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Đóng"><X className="size-4"/></button></div>
      </header>
      <SupportQuickActions disabled={send.isPending} onSelect={sendQuickAction}/>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-stone-50 p-4" aria-live="polite">
        <div className="w-fit max-w-[88%] rounded-2xl rounded-bl-md border border-orange-200 bg-white px-3 py-2.5 text-sm leading-5 text-slate-700 shadow-sm"><strong className="mb-1 block text-xs text-orange-700">Đăng Khoa xin chào!</strong>Bạn có thể chọn hỗ trợ nhanh ở trên hoặc gửi câu hỏi chi tiết cho trợ lý AI.</div>
        {user?.role === 'customer' && session.data?.data?.page.hasMore && <button className="mx-auto block rounded-lg px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Đang tải..." : "Tải tin nhắn cũ"}</button>}
        {messages.map(message => <SupportBubble key={message._id} message={message}/>) }
        {aiStatus === "thinking" && <div className="flex w-fit max-w-[88%] items-center gap-2 rounded-2xl rounded-bl-md border border-orange-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 shadow-sm"><LoaderCircle className="size-4 animate-spin text-orange-600"/>Trợ lý AI đang soạn câu trả lời...</div>}
        {aiStatus === "handoff" && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-800">{user ? 'Yêu cầu cần xác nhận thêm và đã được chuyển tới nhân viên.' : 'Nội dung này cần nhân viên xác nhận. Bạn có thể đăng nhập hoặc liên hệ hotline để được hỗ trợ.'}</p>}
        {user?.role === 'customer' && session.isLoading && <div className="grid place-items-center py-8"><LoaderCircle className="size-6 animate-spin text-orange-600"/></div>}
      </div>
      <form className="border-t border-emerald-100 bg-white p-3" onSubmit={submit}>
        {user?.role === 'customer' && session.error && <p className="mb-2 rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-700">{session.error.message}</p>}
        {send.error && <p className="mb-2 rounded-lg bg-red-50 p-2 text-xs font-semibold text-red-700">{send.error.message}</p>}
        <div className="flex items-end gap-2"><textarea className="max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-2.5 text-sm outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100" value={content} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="Nhập câu hỏi chi tiết..." rows={1}/><button className="grid size-11 shrink-0 place-items-center rounded-full bg-orange-600 text-white shadow-lg shadow-orange-950/20 transition hover:bg-orange-700 disabled:opacity-50" disabled={send.isPending || !content.trim()} aria-label="Gửi tin nhắn">{send.isPending ? <LoaderCircle className="size-5 animate-spin"/> : <Send className="size-5"/>}</button></div>
        <p className="mt-2 text-center text-[10px] text-slate-400">{user ? 'Hội thoại được lưu trong tài khoản của bạn.' : 'Phiên Guest chỉ tồn tại trên trang này và sẽ mất khi tải lại.'}</p>
      </form>
    </section>}
    <div className="flex items-center justify-end gap-2.5">
      <button onClick={() => setOpen(value => !value)} className="support-dock-attention relative grid size-16 shrink-0 place-items-center rounded-full bg-emerald-950 text-white shadow-xl shadow-emerald-950/30 transition duration-300 hover:-translate-y-1 hover:scale-105 hover:bg-emerald-900" aria-expanded={open} aria-label={open ? "Thu nhỏ hỗ trợ khách hàng" : "Mở hỗ trợ khách hàng"}>
        <span className="grid size-10 place-items-center rounded-full bg-orange-500 text-white">{open ? <MessageCircleMore className="size-6"/> : <Headphones className="size-6"/>}</span>{unread > 0 && <span className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[10px] text-white">{Math.min(unread, 99)}</span>}
      </button>
      <a href={company.zaloUrl} target="_blank" rel="noopener noreferrer" title="Nhắn tin qua Zalo" aria-label="Nhắn tin với Đăng Khoa qua Zalo" className="support-dock-attention support-dock-attention-delay group grid size-16 shrink-0 place-items-center rounded-[1.3rem] shadow-xl shadow-blue-950/25 transition duration-300 hover:-translate-y-1 hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-200">
        <ZaloIcon className="size-16"/>
      </a>
    </div>
  </div>
}

function ZaloIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="zalo-blue" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
        <stop stopColor="#0878ff"/>
        <stop offset="1" stopColor="#0561e8"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="18" fill="url(#zalo-blue)"/>
    <path fill="#fff" d="M25 7h23c6.6 0 12 5.4 12 12v25c0 6.6-5.4 12-12 12H27.5c-4.1 0-8-1.1-11.4-3.1L7 57l4.1-10.2A18.4 18.4 0 0 1 8 36.5V24C8 14.6 15.6 7 25 7Z"/>
    <text x="34" y="38.5" fill="#0868ee" fontFamily="Arial, Helvetica, sans-serif" fontSize="20" fontWeight="600" letterSpacing="-1.5" textAnchor="middle">Zalo</text>
  </svg>
}

function SupportBubble({ message }: { message: SupportMessage }) {
  const mine = ['guest', 'customer'].includes(message.senderRole)
  const fromAi = message.senderRole === 'system' && Boolean(message.ai)
  return <div className={cn("w-fit min-w-0 max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-5 shadow-sm [overflow-wrap:anywhere]", mine ? "ml-auto rounded-br-md bg-emerald-900 text-white" : "rounded-bl-md border border-orange-200 bg-white text-slate-700", message.deliveryStatus === 'failed' && "ring-2 ring-red-300")}>
    {fromAi && <p className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-orange-700"><Bot className="size-3.5"/>Trợ lý AI</p>}
    <p className="whitespace-pre-wrap">{message.content}</p><div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-65"><span>{new Date(message.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span>{message.deliveryStatus === 'sending' && <span>· Đang gửi</span>}{message.deliveryStatus === 'failed' && <span>· Gửi lỗi</span>}{mine && message.readAt && <CheckCheck className="size-3"/>}</div></div>
}
