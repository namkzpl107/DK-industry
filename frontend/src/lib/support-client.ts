import { authClient } from "@/lib/auth-client"
import type { SupportConversation, SupportMessage, SupportSession } from "@/types/support"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api"
type Result<T> = { success: boolean; data: T; message?: string }

async function request<T>(path: string, options: RequestInit = {}) {
  if (authClient.accessToken()) return authClient.authenticated<T>(`/support${path}`, options)
  const headers = new Headers(options.headers)
  headers.set("Content-Type", "application/json")
  const response = await fetch(`${API_URL}/support${path}`, { ...options, credentials: "include", headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || "Không thể kết nối bộ phận hỗ trợ")
  return body as T
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

export const supportClient = {
  session: (conversationId?: string) => request<Result<SupportSession | null>>(`/session${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`),
  messages: (before?: string | null, conversationId?: string) => request<Result<{ items: SupportMessage[]; hasMore: boolean; nextCursor: string | null }>>(`/messages?limit=40${before ? `&before=${encodeURIComponent(before)}` : ""}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ""}`),
  send: (body: { content: string; clientMessageId: string; name?: string; phone?: string; email?: string }, conversationId?: string) => request<Result<{ conversation: SupportConversation; message: SupportMessage; socketToken?: string }>>(`/messages${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`, json("POST", body)),
  guestAi: (body: { content: string; history: Array<Pick<SupportMessage, "senderRole" | "content">> }) => request<Result<{ answer: string; needsHuman: boolean; reason: string; fallback?: boolean }>>("/guest-ai", json("POST", body)),
  clearGuestSession: () => request<{ success: boolean }>("/guest-session", json("DELETE")),
  conversations: () => request<Result<SupportConversation[]>>("/conversations"),
  conversation: (id: string) => request<Result<SupportSession>>(`/conversations/${id}`),
  staffMessages: (id: string, before?: string | null) => request<Result<{ items: SupportMessage[]; hasMore: boolean; nextCursor: string | null }>>(`/conversations/${id}/messages?limit=40${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  staffSend: (id: string, content: string, clientMessageId: string) => request<Result<SupportMessage>>(`/conversations/${id}/messages`, json("POST", { content, clientMessageId })),
  update: (id: string, body: { assignedTo?: "me"; status?: "open" | "closed" }) => request<Result<SupportConversation>>(`/conversations/${id}`, json("PATCH", body)),
}
