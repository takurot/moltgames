import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MatchStatusBadge } from '@/components/MatchStatusBadge';
import type { MatchStatus } from '@moltgames/domain';

describe('MatchStatusBadge', () => {
  it('renders CREATED status', () => {
    render(<MatchStatusBadge status="CREATED" />);
    expect(screen.getByText('CREATED')).toBeInTheDocument();
  });

  it('renders IN_PROGRESS status', () => {
    render(<MatchStatusBadge status="IN_PROGRESS" />);
    expect(screen.getByText('IN_PROGRESS')).toBeInTheDocument();
  });

  it('renders FINISHED status with terminal style', () => {
    render(<MatchStatusBadge status="FINISHED" />);
    const badge = screen.getByText('FINISHED');
    expect(badge).toBeInTheDocument();
    expect(badge.closest('[data-terminal]')).toHaveAttribute('data-terminal', 'true');
  });

  it('renders ABORTED status with terminal style', () => {
    render(<MatchStatusBadge status="ABORTED" />);
    const badge = screen.getByText('ABORTED');
    expect(badge.closest('[data-terminal]')).toHaveAttribute('data-terminal', 'true');
  });

  it('renders CANCELLED status with terminal style', () => {
    render(<MatchStatusBadge status="CANCELLED" />);
    const badge = screen.getByText('CANCELLED');
    expect(badge.closest('[data-terminal]')).toHaveAttribute('data-terminal', 'true');
  });

  it('non-terminal statuses do not have terminal marker', () => {
    render(<MatchStatusBadge status="WAITING_AGENT_CONNECT" />);
    const badge = screen.getByText('WAITING_AGENT_CONNECT');
    expect(badge.closest('[data-terminal]')).toHaveAttribute('data-terminal', 'false');
  });

  it('applies a role="status" for accessibility', () => {
    render(<MatchStatusBadge status="READY" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
