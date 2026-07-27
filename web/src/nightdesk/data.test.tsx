import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Avatar,
  Badge,
  Breadcrumbs,
  EmptyState,
  Pagination,
  Progress,
  Skeleton,
  Spinner,
  Stat,
} from './data';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ Stat */

describe('Stat', () => {
  it('renders the label and value, and emits no delta node when there is no delta', () => {
    const { container } = render(<Stat label="Devices up" value="184" />);
    expect(container.querySelector('.nd-micro-label')?.textContent).toBe('Devices up');
    expect(container.querySelector('.nd-stat__value')?.textContent).toBe('184');
    expect(container.querySelector('.nd-stat__delta')).toBeNull();
  });

  it('prints an unknown value verbatim and attaches no delta chip to it', () => {
    // A plane that reported nothing must read as '—'. Inventing a figure, or
    // hanging a coloured trend chip off a value that does not exist, would
    // present an unknown as a measurement.
    const { container } = render(<Stat label="Assigned" value="—" />);
    expect(container.querySelector('.nd-stat__value')?.textContent).toBe('—');
    expect(container.querySelector('.nd-stat__delta')).toBeNull();
  });

  it('renders a real zero as 0, distinct from the unknown dash', () => {
    const { container } = render(<Stat label="Open alerts" value={0} />);
    expect(container.querySelector('.nd-stat__value')?.textContent).toBe('0');
  });

  it.each([
    [undefined, 'nd-stat__delta--neutral'],
    ['neutral', 'nd-stat__delta--neutral'],
    ['positive', 'nd-stat__delta--positive'],
    ['negative', 'nd-stat__delta--negative'],
  ] as const)('maps deltaTone %s onto %s', (tone, expected) => {
    const { container } = render(
      <Stat label="Devices up" value="184" delta="+6" deltaTone={tone} />,
    );
    const delta = container.querySelector('.nd-stat__delta') as HTMLElement;
    expect(delta.textContent).toBe('+6');
    expect(delta.className).toBe(`nd-stat__delta ${expected}`);
  });

  it('drops an empty delta string rather than painting an empty coloured chip', () => {
    const { container } = render(<Stat label="Devices up" value="184" delta="" deltaTone="positive" />);
    expect(container.querySelector('.nd-stat__delta')).toBeNull();
  });
});

/* ----------------------------------------------------------------- Badge */

describe('Badge', () => {
  it('defaults to the neutral tone', () => {
    const { container } = render(<Badge>Unknown</Badge>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe('nd-badge nd-badge--neutral');
    expect(el.textContent).toBe('Unknown');
  });

  it.each(['success', 'warning', 'danger', 'info', 'neutral', 'accent'] as const)(
    'maps tone %s onto its own class',
    (tone) => {
      const { container } = render(<Badge tone={tone}>Up</Badge>);
      expect((container.firstElementChild as HTMLElement).className).toBe(
        `nd-badge nd-badge--${tone}`,
      );
    },
  );

  it('renders the status dot only when asked, and never in place of the label', () => {
    const { container, rerender } = render(<Badge tone="success">Up</Badge>);
    expect(container.querySelector('.nd-badge__dot')).toBeNull();

    rerender(
      <Badge tone="success" dot>
        Up
      </Badge>,
    );
    expect(container.querySelector('.nd-badge__dot')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).textContent).toBe('Up');
  });
});

/* ---------------------------------------------------------------- Avatar */

describe('Avatar', () => {
  it('falls back to initials — there is no image path — and keeps the full name reachable', () => {
    const { container } = render(<Avatar name="R. Okafor" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe('RO');
    expect(el.getAttribute('title')).toBe('R. Okafor');
  });

  it('takes at most two initials and ignores digits and punctuation', () => {
    const { container } = render(<Avatar name="ap-lake-01" />);
    expect((container.firstElementChild as HTMLElement).textContent).toBe('AL');

    const { container: three } = render(<Avatar name="ada b lovelace" />);
    expect((three.firstElementChild as HTMLElement).textContent).toBe('AB');
  });

  it('uppercases a lowercase name', () => {
    const { container } = render(<Avatar name="sam okonkwo" />);
    expect((container.firstElementChild as HTMLElement).textContent).toBe('SO');
  });

  it('renders no invented glyph for a name with no Latin letters, but still carries the name', () => {
    // A blank circle is honest; a placeholder letter that is not in the name
    // would be a fabricated identity.
    const { container } = render(<Avatar name="8675309" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe('');
    expect(el.getAttribute('title')).toBe('8675309');
  });

  it.each([
    [undefined, 'nd-avatar--sm'],
    ['sm', 'nd-avatar--sm'],
    ['md', 'nd-avatar--md'],
  ] as const)('maps size %s onto %s', (size, expected) => {
    const { container } = render(<Avatar name="R. Okafor" size={size} />);
    expect((container.firstElementChild as HTMLElement).className).toBe(`nd-avatar ${expected}`);
  });
});

/* -------------------------------------------------------------- Progress */

describe('Progress', () => {
  const fillOf = (c: HTMLElement) => c.querySelector('.nd-progress__fill') as HTMLElement;

  it('declares an explicit 0% width at zero, so an empty reading is drawn empty', () => {
    // The fill div carries no width in components.css: whatever width the
    // inline style declares is the only thing stopping a block-level div from
    // filling its track edge to edge.
    const { container } = render(<Progress value={0} />);
    expect(fillOf(container).style.width).toBe('0%');
  });

  it('clamps a negative reading to 0% instead of inverting the bar', () => {
    const { container } = render(<Progress value={-20} />);
    expect(fillOf(container).style.width).toBe('0%');
  });

  it('clamps an over-max reading to 100% so the fill never escapes the track', () => {
    const { container } = render(<Progress value={140} />);
    expect(fillOf(container).style.width).toBe('100%');
  });

  it('scales against a non-default max', () => {
    const { container } = render(<Progress value={24} max={60} />);
    expect(fillOf(container).style.width).toBe('40%');
  });

  it('reports the raw value and max to assistive tech, not the clamped percentage', () => {
    render(<Progress value={24} max={60} label="Auth failures" />);
    const track = screen.getByRole('progressbar');
    expect(track.getAttribute('aria-valuenow')).toBe('24');
    expect(track.getAttribute('aria-valuemin')).toBe('0');
    expect(track.getAttribute('aria-valuemax')).toBe('60');
  });

  it('omits the head row entirely when there is neither label nor note', () => {
    const { container } = render(<Progress value={50} />);
    expect(container.querySelector('.nd-progress__head')).toBeNull();
    expect(container.querySelector('.nd-progress__track')).not.toBeNull();
  });

  it('keeps a note right-aligned with a spacer when there is no label', () => {
    const { container } = render(<Progress value={50} note="1,842 of 2,046 leases" />);
    const head = container.querySelector('.nd-progress__head') as HTMLElement;
    expect(head.children).toHaveLength(2);
    expect(head.children[0].textContent).toBe('');
    expect((head.children[1] as HTMLElement).className).toBe('nd-progress__note');
    expect(head.children[1].textContent).toBe('1,842 of 2,046 leases');
    expect(container.querySelector('.nd-micro-label')).toBeNull();
  });

  it('renders the label alone without a note node', () => {
    const { container } = render(<Progress value={50} label="Pass rate" />);
    const head = container.querySelector('.nd-progress__head') as HTMLElement;
    expect(head.children).toHaveLength(1);
    expect(head.children[0].textContent).toBe('Pass rate');
    expect(container.querySelector('.nd-progress__note')).toBeNull();
  });

  it.each([
    [undefined, 'nd-progress__fill--accent'],
    ['accent', 'nd-progress__fill--accent'],
    ['success', 'nd-progress__fill--success'],
    ['warning', 'nd-progress__fill--warning'],
    ['danger', 'nd-progress__fill--danger'],
  ] as const)('maps tone %s onto %s', (tone, expected) => {
    const { container } = render(<Progress value={50} tone={tone} />);
    expect(fillOf(container).className).toBe(`nd-progress__fill ${expected}`);
  });

  it('appends a caller className to the wrapper only', () => {
    const { container } = render(<Progress value={50} className="wide" />);
    expect((container.firstElementChild as HTMLElement).className).toBe('nd-progress wide');
  });
});

/* ------------------------------------------------------------ EmptyState */

describe('EmptyState', () => {
  it('renders its message rather than a blank node', () => {
    const { container } = render(<EmptyState title="No tickets in the queue" />);
    expect(container.querySelector('.nd-empty__title')?.textContent).toBe('No tickets in the queue');
    expect((container.firstElementChild as HTMLElement).textContent).not.toBe('');
  });

  it('renders the description only when one is supplied', () => {
    const { container, rerender } = render(<EmptyState title="No findings to report" />);
    expect(container.querySelector('.nd-empty__desc')).toBeNull();

    rerender(
      <EmptyState title="No findings to report" description="Every check in this snapshot passed." />,
    );
    expect(container.querySelector('.nd-empty__desc')?.textContent).toBe(
      'Every check in this snapshot passed.',
    );
  });

  it('renders an action after the message so the empty state can offer a way out', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <EmptyState title="No devices" description="Nothing was returned.">
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </EmptyState>,
    );
    const kids = Array.from((container.firstElementChild as HTMLElement).children);
    expect(kids.map((k) => k.className)).toEqual(['nd-empty__title', 'nd-empty__desc', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------- Spinner / Skeleton */

describe('Spinner', () => {
  it('announces itself as a loading status and defaults to the small size', () => {
    render(<Spinner />);
    const el = screen.getByRole('status', { name: 'Loading' });
    expect(el.className).toBe('nd-spinner nd-spinner--sm');
  });

  it('carries the md size', () => {
    render(<Spinner size="md" />);
    expect(screen.getByRole('status', { name: 'Loading' }).className).toContain('nd-spinner--md');
  });
});

describe('Skeleton', () => {
  it('defaults to a 12px bar and declares no width, so it fills its container', () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe('nd-skeleton');
    expect(el.style.height).toBe('12px');
    expect(el.style.width).toBe('');
  });

  it('accepts numeric and string widths', () => {
    const { container: num } = render(<Skeleton width={80} />);
    expect((num.firstElementChild as HTMLElement).style.width).toBe('80px');

    const { container: pct } = render(<Skeleton width="72%" />);
    expect((pct.firstElementChild as HTMLElement).style.width).toBe('72%');
  });

  it('lets a caller style and className override the computed defaults', () => {
    const { container } = render(<Skeleton className="tall" height={12} style={{ height: 40 }} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe('nd-skeleton tall');
    expect(el.style.height).toBe('40px');
  });
});

/* ----------------------------------------------------------- Breadcrumbs */

describe('Breadcrumbs', () => {
  const CRUMBS = [
    { label: 'Portal', onClick: vi.fn() },
    { label: 'Sites', onClick: vi.fn() },
    { label: 'Lakeside Clinic' },
  ];

  it('is a labelled navigation landmark', () => {
    render(<Breadcrumbs items={CRUMBS} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumbs' })).toBeTruthy();
  });

  it('puts a separator between crumbs but not before the first', () => {
    const { container } = render(<Breadcrumbs items={CRUMBS} />);
    expect(container.querySelectorAll('.nd-crumbs__sep')).toHaveLength(CRUMBS.length - 1);
    expect((container.querySelector('nav')?.textContent ?? '').startsWith('Portal')).toBe(true);
  });

  it('renders navigable crumbs as buttons and the trailing one as current text', () => {
    const { container } = render(<Breadcrumbs items={CRUMBS} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Portal', 'Sites']);
    const current = container.querySelector('.nd-crumbs__item--current') as HTMLElement;
    expect(current.textContent).toBe('Lakeside Clinic');
    expect(current.tagName).toBe('SPAN');
  });

  it('navigates on click', () => {
    const onPortal = vi.fn();
    render(<Breadcrumbs items={[{ label: 'Portal', onClick: onPortal }, { label: 'Sites' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Portal' }));
    expect(onPortal).toHaveBeenCalledTimes(1);
  });

  it('renders a single crumb as current with no separator', () => {
    const { container } = render(<Breadcrumbs items={[{ label: 'Portal' }]} />);
    expect(container.querySelectorAll('.nd-crumbs__sep')).toHaveLength(0);
    expect(container.querySelector('.nd-crumbs__item--current')?.textContent).toBe('Portal');
  });
});

/* ------------------------------------------------------------ Pagination */

describe('Pagination', () => {
  const pagesOf = (container: HTMLElement) =>
    Array.from(container.querySelector('.nd-pagination')?.children ?? [])
      .slice(1, -1)
      .map((el) => el.textContent);

  it('lists every page without a gap when the run is short', () => {
    const { container } = render(<Pagination page={3} total={7} onChange={vi.fn()} />);
    expect(pagesOf(container)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(container.querySelector('.nd-pagination__gap')).toBeNull();
  });

  it('marks exactly one current page', () => {
    const { container } = render(<Pagination page={3} total={7} onChange={vi.fn()} />);
    const current = container.querySelectorAll('.nd-pagebtn--current');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('3');
  });

  it('elides the middle of a long run while keeping the ends and the neighbours', () => {
    const { container } = render(<Pagination page={5} total={10} onChange={vi.fn()} />);
    expect(pagesOf(container)).toEqual(['1', '2', '…', '4', '5', '6', '…', '9', '10']);
  });

  it('does not print a gap marker between consecutive pages', () => {
    const { container } = render(<Pagination page={3} total={10} onChange={vi.fn()} />);
    expect(pagesOf(container)).toEqual(['1', '2', '3', '4', '…', '9', '10']);
  });

  it('disables the arrow that cannot act rather than letting it act out of range', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Pagination page={1} total={4} onChange={onChange} />);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    rerender(<Pagination page={4} total={4} onChange={onChange} />);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('steps by one from each arrow and jumps from a page button', () => {
    const onChange = vi.fn();
    render(<Pagination page={3} total={10} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: '10' }));
    expect(onChange).toHaveBeenLastCalledWith(10);
  });

  it('offers no page to go to when there are no results', () => {
    const { container } = render(<Pagination page={1} total={0} onChange={vi.fn()} />);
    expect(pagesOf(container)).toEqual([]);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
