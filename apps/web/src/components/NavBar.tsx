'use client';

import Link from 'next/link';

interface NavUser {
  displayName: string;
  uid: string;
}

interface Props {
  user: NavUser | null;
  onSignOut: () => void;
}

export function NavBar({ user, onSignOut }: Props) {
  return (
    <nav className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
      <Link href="/" className="text-xl font-bold text-indigo-600">
        Moltgames
      </Link>
      <div className="flex items-center gap-4">
        {user !== null ? (
          <>
            <span className="text-sm text-gray-700">{user.displayName}</span>
            <button
              onClick={onSignOut}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Logout
            </button>
          </>
        ) : (
          <Link
            href="/login"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
          >
            Login
          </Link>
        )}
      </div>
    </nav>
  );
}
