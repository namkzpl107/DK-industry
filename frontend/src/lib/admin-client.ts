import { authClient } from "@/lib/auth-client"
import type { AboutSiteSetting, AdminDashboard, AdminPaged, AdminPrivacyRequest, AdminProduct, AdminProject, AdminService, AdminUser, AdminWorkOrder, AuditLog } from "@/types/admin"

type Result<T> = { success: boolean; data: T; message?: string }
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })
const query = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])).toString()

export const adminClient = {
  dashboard: () => authClient.authenticated<Result<AdminDashboard>>("/admin/dashboard"),
  workOrders: (filters: { q?: string; state?: string; page?: number } = {}) => authClient.authenticated<Result<AdminPaged<AdminWorkOrder>>>(`/admin/work-orders?${query(filters)}`),
  workOrder: (id: string) => authClient.authenticated<Result<AdminWorkOrder>>(`/admin/work-orders/${id}`),
  uploadImage: (file: File) => { const body = new FormData(); body.append("image", file); return authClient.authenticated<Result<{ url: string; filename: string }>>("/admin/uploads/images", { method: "POST", body }) },
  aboutSettings: () => authClient.authenticated<Result<AboutSiteSetting>>("/admin/site-settings/about"),
  updateAboutSettings: (body: Partial<AboutSiteSetting>) => authClient.authenticated<Result<AboutSiteSetting>>("/admin/site-settings/about", json("PATCH", body)),
  users: (filters: { q?: string; role?: string; status?: string; page?: number; limit?: number } = {}) => authClient.authenticated<Result<AdminPaged<AdminUser>>>(`/admin/users?${query(filters)}`),
  createUser: (body: { name: string; email: string; phone: string; password: string; role: "staff" | "admin" }) => authClient.authenticated<Result<AdminUser>>("/admin/users", json("POST", body)),
  updateUser: (id: string, body: Partial<Pick<AdminUser, "name" | "email" | "phone" | "role" | "status">>) => authClient.authenticated<Result<AdminUser>>(`/admin/users/${id}`, json("PATCH", body)),
  resetPassword: (id: string, password: string) => authClient.authenticated<{ success: boolean; message: string }>(`/admin/users/${id}/reset-password`, json("POST", { password })),
  products: (filters: { q?: string; state?: string; page?: number } = {}) => authClient.authenticated<Result<AdminPaged<AdminProduct>>>(`/admin/products?${query(filters)}`),
  createProduct: (body: Record<string, unknown>) => authClient.authenticated<Result<AdminProduct>>("/admin/products", json("POST", body)),
  updateProduct: (id: string, body: Record<string, unknown>) => authClient.authenticated<Result<AdminProduct>>(`/admin/products/${id}`, json("PATCH", body)),
  setProductStatus: (id: string, status: string) => authClient.authenticated<Result<AdminProduct>>(`/admin/products/${id}/status`, json("PATCH", { status })),
  services: (filters: { q?: string; state?: string; page?: number } = {}) => authClient.authenticated<Result<AdminPaged<AdminService>>>(`/admin/services?${query(filters)}`),
  createService: (body: Record<string, unknown>) => authClient.authenticated<Result<AdminService>>("/admin/services", json("POST", body)),
  updateService: (id: string, body: Record<string, unknown>) => authClient.authenticated<Result<AdminService>>(`/admin/services/${id}`, json("PATCH", body)),
  setServiceStatus: (id: string, status: string) => authClient.authenticated<Result<AdminService>>(`/admin/services/${id}/status`, json("PATCH", { status })),
  projects: (filters: { q?: string; state?: string; page?: number } = {}) => authClient.authenticated<Result<AdminPaged<AdminProject>>>(`/admin/projects?${query(filters)}`),
  createProject: (body: Record<string, unknown>) => authClient.authenticated<Result<AdminProject>>("/admin/projects", json("POST", body)),
  updateProject: (id: string, body: Record<string, unknown>) => authClient.authenticated<Result<AdminProject>>(`/admin/projects/${id}`, json("PATCH", body)),
  setProjectStatus: (id: string, status: string) => authClient.authenticated<Result<AdminProject>>(`/admin/projects/${id}/status`, json("PATCH", { status })),
  auditLogs: (entity = "", page = 1) => authClient.authenticated<Result<AdminPaged<AuditLog>>>(`/admin/audit-logs?${query({ entity, page })}`),
  privacyRequests: (status = "", page = 1, privacyRequestId = "") => authClient.authenticated<Result<AdminPaged<AdminPrivacyRequest>>>(`/admin/privacy-requests?${query({ status, page, privacyRequestId })}`),
  updatePrivacyRequest: (id: string, body: { status: string; resolution: string }) => authClient.authenticated<Result<AdminPrivacyRequest>>(`/admin/privacy-requests/${id}`, json("PATCH", body)),
}
