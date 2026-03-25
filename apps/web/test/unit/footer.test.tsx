import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from '@/components/Footer';

describe('Footer', () => {
  it('displays the Moltgames name', () => {
    render(<Footer />);
    expect(screen.getByText(/moltgames/i)).toBeInTheDocument();
  });

  it('displays copyright notice', () => {
    render(<Footer />);
    expect(screen.getByText(/all rights reserved/i)).toBeInTheDocument();
  });
});
