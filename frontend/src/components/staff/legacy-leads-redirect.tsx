import { Navigate, useLocation } from "react-router-dom"

export function LegacyLeadsRedirect() {
  const { search, hash } = useLocation()
  return <Navigate to={`/staff/requests${search}${hash}`} replace />
}
