import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { NotificationsPage } from "./notifications-page"
import { StaffSupportPage } from "./staff-support-page"
import { StaffOrdersWorkspacePage } from "./staff-orders-workspace-page"
import { SupportChatWidget } from "@/components/support-chat-widget"
import { notificationClient } from "@/lib/notification-client"
import { supportClient } from "@/lib/support-client"
import { staffClient } from "@/lib/staff-client"

vi.mock("@/hooks/use-page-meta", () => ({ usePageMeta: () => {} }))
vi.mock("@/components/staff/staff-shell", () => ({ StaffShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock("@/lib/notification-client", () => ({ notificationClient: { list: vi.fn(), read: vi.fn(), readAll: vi.fn() } }))
vi.mock("@/lib/staff-client", () => ({ staffClient: { orders: vi.fn(), order: vi.fn() } }))
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => ({ user: { id: "customer-a", role: "customer" }, ready: true }) }))
vi.mock("@/lib/support-client", () => ({ supportClient: { conversations: vi.fn(), conversation: vi.fn(), session: vi.fn() } }))
vi.mock("@/lib/support-socket", () => ({ acquireSupportSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false }), releaseSupportSocket: vi.fn(), storeSupportSocketToken: vi.fn(), supportSocket: { emit: vi.fn() } }))

function Location() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}
const clients: QueryClient[] = []
async function mount(page: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  clients.push(client)
  // Flush resolved API mocks and React updates before testing the page.
  await act(async () => {
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{page}<Location/></MemoryRouter></QueryClientProvider>)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  // Query notifications normally use setTimeout(0). Microtasks let act flush
  // them deterministically even when coverage workers keep the CPU busy.
  notifyManager.setScheduler(queueMicrotask)
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  notifyManager.setScheduler(defaultScheduler)
})

describe("notification detail navigation", () => {
  it.each(["lead-a", "lead-b"])("uses the resolved destination for historical reminder %s", async leadId => {
    const item = { _id: leadId, type: "lead.follow_up_overdue", title: `Chăm sóc ${leadId}`, message: "Liên hệ khách hàng", link: "/staff/leads", createdAt: new Date().toISOString() }
    vi.mocked(notificationClient.list).mockResolvedValue({ success: true, data: { items: [item], unread: 1, total: 1, allTotal: 1, page: 1, pages: 1 } })
    vi.mocked(notificationClient.read).mockResolvedValue({ success: true, data: { ...item, link: `/staff/requests?leadId=${leadId}` } })
    await mount(<NotificationsPage/>, "/thong-bao")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(`Chăm sóc ${leadId}`) })) })
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/staff/requests?leadId=${leadId}`))
    expect(notificationClient.read).toHaveBeenCalledWith(leadId)
  })

  it("shows an error without redirecting when opening a notification fails", async () => {
    const item = { _id: "n", type: "request.created", title: "Yêu cầu A", message: "Khách A", link: "/staff/requests", createdAt: new Date().toISOString() }
    vi.mocked(notificationClient.list).mockResolvedValue({ success: true, data: { items: [item], unread: 1, total: 1, allTotal: 1, page: 1, pages: 1 } })
    vi.mocked(notificationClient.read).mockRejectedValue(new Error("Không thể mở thông báo"))
    await mount(<NotificationsPage/>, "/thong-bao")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Yêu cầu A/ })) })
    expect(await screen.findByRole("alert")).toHaveTextContent("Không thể mở thông báo")
    expect(screen.getByTestId("location")).toHaveTextContent("/thong-bao")
  })

  it("loads the linked conversation even if it is absent from the inbox", async () => {
    vi.mocked(supportClient.conversations).mockResolvedValue({ success: true, data: [] })
    vi.mocked(supportClient.conversation).mockRejectedValue(new Error("Hội thoại không còn tồn tại"))
    await mount(<StaffSupportPage/>, "/staff/support?conversationId=chat-a")
    expect(await screen.findByRole("alert")).toHaveTextContent("Hội thoại không còn tồn tại")
    expect(supportClient.conversation).toHaveBeenCalledWith("chat-a")
  })

  it("opens the customer's linked conversation and never substitutes the current session", async () => {
    vi.mocked(supportClient.session).mockRejectedValue(new Error("Không tìm thấy cuộc trò chuyện"))
    await mount(<SupportChatWidget/>, "/?support=open&supportConversationId=old-chat")
    expect(await screen.findByText("Không tìm thấy cuộc trò chuyện")).toBeVisible()
    expect(supportClient.session).toHaveBeenCalledWith("old-chat")
    // Exercise the delayed scroll instead of ending before its timer fires.
    await waitFor(() => expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "smooth" }))
  })

  it("opens an order outside the current list page and reports a missing order", async () => {
    vi.mocked(staffClient.orders).mockResolvedValue({ success: true, data: { items: [], total: 0, page: 1, pages: 1 } })
    vi.mocked(staffClient.order).mockRejectedValue(new Error("Không tìm thấy đơn hàng"))
    await mount(<StaffOrdersWorkspacePage/>, "/staff/orders?orderId=order-a")
    expect(await screen.findByRole("alert")).toHaveTextContent("Không tìm thấy đơn hàng")
    expect(staffClient.order).toHaveBeenCalledWith("order-a")
  })
})
