import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavBar } from '@/components/NavBar';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('NavBar', () => {
  it('renders the site name', () => {
    render(<NavBar user={null} onSignOut={vi.fn()} />);
    expect(screen.getByText('Moltgames')).toBeInTheDocument();
  });

  it('shows login link when user is not authenticated', () => {
    render(<NavBar user={null} onSignOut={vi.fn()} />);
    expect(screen.getByRole('link', { name: /login/i })).toBeInTheDocument();
  });

  it('does not show logout button when user is not authenticated', () => {
    render(<NavBar user={null} onSignOut={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /logout/i })).not.toBeInTheDocument();
  });

  it('shows logout button when user is authenticated', () => {
    const user = { displayName: 'TestBot', uid: 'uid-1' };
    render(<NavBar user={user} onSignOut={vi.fn()} />);
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
  });

  it('does not show login link when user is authenticated', () => {
    const user = { displayName: 'TestBot', uid: 'uid-1' };
    render(<NavBar user={user} onSignOut={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /login/i })).not.toBeInTheDocument();
  });

  it('displays user display name when authenticated', () => {
    const user = { displayName: 'Alice', uid: 'uid-2' };
    render(<NavBar user={user} onSignOut={vi.fn()} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('calls onSignOut when logout button is clicked', async () => {
    const onSignOut = vi.fn();
    const user = { displayName: 'Bob', uid: 'uid-3' };
    render(<NavBar user={user} onSignOut={onSignOut} />);

    await userEvent.click(screen.getByRole('button', { name: /logout/i }));

    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('has a nav landmark', () => {
    render(<NavBar user={null} onSignOut={vi.fn()} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});
