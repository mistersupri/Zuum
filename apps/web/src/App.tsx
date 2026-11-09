import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { LoadingBlock } from "./components/ui";
import { AppShell } from "./components/AppShell";
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./pages/Auth";
import { DashboardPage } from "./pages/Dashboard";
import { HistoryPage } from "./pages/History";
import { CreateMeetingPage } from "./pages/CreateMeeting";
import { JoinPage } from "./pages/Join";
import { MeetingDetailPage } from "./pages/MeetingDetail";
import { ProfilePage } from "./pages/Profile";
import { NotFoundPage } from "./pages/NotFound";
// The room pulls in the LiveKit SDK; load it only when someone actually joins.
const MeetingRoomPage = lazy(() => import("./room/MeetingRoom").then((m) => ({ default: m.MeetingRoomPage })));

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <LoadingBlock label="Memeriksa sesi..." />;
  if (status === "anonymous") return <Navigate to={`/masuk?lanjut=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/masuk" element={<LoginPage />} />
      <Route path="/daftar" element={<RegisterPage />} />
      <Route path="/lupa-sandi" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      <Route path="/" element={<Shell><DashboardPage /></Shell>} />
      <Route path="/riwayat" element={<Shell><HistoryPage /></Shell>} />
      <Route path="/rapat/baru" element={<Shell><CreateMeetingPage /></Shell>} />
      <Route path="/rapat/:meetingId" element={<Shell><MeetingDetailPage /></Shell>} />
      <Route path="/profil" element={<Shell><ProfilePage /></Shell>} />

      {/* Join works for signed-in users and for guests holding an invitation link. */}
      <Route path="/j/:token" element={<JoinPage />} />
      <Route path="/m/:meetingId" element={<JoinPage />} />
      <Route
        path="/m/:meetingId/ruang"
        element={
          <Suspense fallback={<LoadingBlock label="Menyiapkan ruang rapat..." />}>
            <MeetingRoomPage />
          </Suspense>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
