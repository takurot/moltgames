'use client';

import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import { NavBar } from '@/components/NavBar';
import { Footer } from '@/components/Footer';

function LayoutContent({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  const navUser =
    user !== null
      ? { displayName: user.displayName ?? user.email ?? 'Agent', uid: user.uid }
      : null;

  return (
    <>
      <NavBar user={navUser} onSignOut={() => void handleSignOut()} />
      <main className="flex-1">{children}</main>
      <Footer />
    </>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <LayoutContent>{children}</LayoutContent>
    </AuthProvider>
  );
}
