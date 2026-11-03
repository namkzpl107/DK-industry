import { useQuery } from "@tanstack/react-query"
import { ClipboardList, FileCog, FolderKanban, LogOut, Mail, Phone, ShieldCheck, UserRound } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { PrivacyCard } from "@/components/customer/privacy-card"
import { useState } from "react"
import { CustomerShell } from "@/components/customer/customer-shell"
import { PasswordCard } from "@/components/customer/password-card"
import { SessionsCard } from "@/components/customer/sessions-card"
import { MfaCard } from "@/components/admin/mfa-card"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/contexts/auth-context"
import { usePageMeta } from "@/hooks/use-page-meta"
import { customerClient } from "@/lib/customer-client"
import { authClient } from "@/lib/auth-client"

const roleNames = { customer: "Khách hàng", staff: "Nhân viên", admin: "Quản trị viên" }

export function AccountPage() {
  usePageMeta("Tài khoản", "Quản lý tài khoản Cơ khí Đăng Khoa.")
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const summary = useQuery({ queryKey: ["customer", "summary"], queryFn: customerClient.summary, enabled: user?.role === "customer" })
  if (!user) return null
  if (user.role === "customer" && params.has("privacyRequestId")) return <CustomerShell title="Quyền riêng tư" description="Chi tiết yêu cầu dữ liệu cá nhân của bạn."><PrivacyCard/></CustomerShell>
  const handleLogout = async () => { try { await logout() } finally { navigate("/", { replace: true }) } }

  if (user.role !== "customer") return <section className="section-space bg-stone-100"><div className="container-page max-w-4xl"><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-orange-700">Tài khoản nội bộ</p><h1 className="mt-2 font-display text-4xl font-bold text-emerald-950">Xin chào, {user.name}</h1></div><div className="flex flex-wrap gap-2"><Button asChild><Link to={user.role === "admin" ? "/admin" : "/staff"}>{user.role === "admin" ? "Vào khu vực quản trị" : "Vào khu vực làm việc"}</Link></Button><Button variant="outline" onClick={handleLogout}><LogOut className="size-5"/>Đăng xuất</Button></div></div><div className="grid gap-6 md:grid-cols-2"><ProfileCard/><PasswordCard/>{user.role === "admin" && <MfaCard/>}</div><div className="mt-6"><SessionsCard/></div></div></section>
  if (summary.error) return <CustomerShell title={`Xin chào, ${user.name}`} description="Không thể tải tổng quan tài khoản."><p role="alert" className="rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{summary.error.message}</p></CustomerShell>

  const data = summary.data?.data
  const cards = [
    { label: "Yêu cầu gia công", value: data?.openRequests ?? 0, detail: "Đang được kiểm tra hoặc báo giá", icon: FileCog, to: "/tai-khoan/yeu-cau" },
    { label: "Dự án đang triển khai", value: data?.activeProjects ?? 0, detail: "Theo dõi tiến độ thực hiện", icon: FolderKanban, to: "/tai-khoan/du-an" },
    { label: "Đơn sản phẩm", value: data?.openOrders ?? 0, detail: `${data?.orders ?? 0} đơn tất cả`, icon: ClipboardList, to: "/tai-khoan/don-hang" },
  ]
  return <CustomerShell title={`Xin chào, ${user.name}`} description="Theo dõi đơn hàng, yêu cầu gia công và thông tin giao nhận tại một nơi."><div className="grid gap-5 md:grid-cols-3">{cards.map(({ label, value, detail, icon: Icon, to }) => <Link to={to} key={label} className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition  hover:border-orange-300 "><span className="grid size-12 place-items-center rounded-2xl bg-emerald-950 text-white"><Icon className="size-6"/></span><strong className="mt-6 block font-display text-4xl text-orange-700">{summary.isLoading ? "–" : value}</strong><h2 className="mt-1 text-lg font-bold text-emerald-950">{label}</h2><p className="mt-2 text-sm text-slate-500">{detail}</p></Link>)}</div><div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_.8fr]"><ProfileCard/><article className="rounded-3xl bg-emerald-950 p-7 text-white"><h2 className="font-display text-2xl font-bold">Cần gia công theo bản vẽ?</h2><p className="mt-3 leading-7 text-emerald-50/70">Gửi PDF, DXF, DWG hoặc STEP. Kỹ thuật sẽ kiểm tra và phản hồi theo mã yêu cầu.</p><Button asChild className="mt-6"><Link to="/tai-khoan/yeu-cau">Tạo yêu cầu mới</Link></Button></article></div><div className="mt-6"><SessionsCard/></div></CustomerShell>
}

function ProfileCard() {
  const { user } = useAuth()
  const [verificationMessage, setVerificationMessage] = useState("")
  const [verificationError, setVerificationError] = useState("")
  const [sendingVerification, setSendingVerification] = useState(false)
  if (!user) return null
  const resend = async () => { setSendingVerification(true); setVerificationError(""); try { setVerificationMessage((await authClient.resendVerification()).message) } catch (error) { setVerificationError(error instanceof Error ? error.message : "Không thể gửi email xác minh") } finally { setSendingVerification(false) } }
  return <article className="rounded-3xl border border-slate-200 bg-white p-7"><div className="flex items-start gap-4"><span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-orange-50 text-orange-700"><UserRound className="size-7"/></span><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-black uppercase tracking-wider text-emerald-800">{roleNames[user.role]}</span><span className="flex items-center gap-1 text-xs font-bold text-emerald-700"><ShieldCheck className="size-4"/>Đang hoạt động</span></div><h2 className="mt-3 font-display text-2xl font-bold text-emerald-950">{user.name}</h2></div></div><div className="mt-6 space-y-3 text-sm text-slate-600"><p className="flex items-center gap-3"><Mail className="size-5 text-orange-600"/>{user.email}<span className={`rounded-full px-2 py-1 text-xs font-bold ${user.emailVerified ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{user.emailVerified ? "Đã xác minh" : "Chưa xác minh"}</span></p><p className="flex items-center gap-3"><Phone className="size-5 text-orange-600"/>{user.phone}</p></div>{!user.emailVerified && <div className="mt-4"><Button size="sm" variant="ghost" disabled={sendingVerification} onClick={() => void resend()}>{sendingVerification ? "Đang gửi..." : "Gửi lại email xác minh"}</Button>{verificationMessage && <p role="status" className="mt-2 text-sm font-semibold text-emerald-700">{verificationMessage}</p>}{verificationError && <p role="alert" className="mt-2 text-sm font-semibold text-red-700">{verificationError}</p>}</div>}{user.role === "customer" && <Button asChild variant="outline" className="mt-6"><Link to="/tai-khoan/ho-so">Cập nhật hồ sơ & địa chỉ</Link></Button>}</article>
}
