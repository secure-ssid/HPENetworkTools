import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  Card,
  Code,
  Divider,
  Heading,
  Kbd,
  NightdeskProvider,
  SectionHeader,
  Stack,
  Text,
} from './primitives';

afterEach(cleanup);

describe('NightdeskProvider', () => {
  it('roots the tree under nd-root so the token layer applies', () => {
    const { container } = render(
      <NightdeskProvider>
        <span>body</span>
      </NightdeskProvider>,
    );
    expect(container.querySelector('.nd-root')?.textContent).toBe('body');
  });
});

describe('Stack', () => {
  it('defaults to a flex column and emits no gap when none is asked for', () => {
    const { container } = render(
      <Stack>
        <span>a</span>
      </Stack>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.display).toBe('flex');
    expect(el.style.flexDirection).toBe('column');
    expect(el.style.gap).toBe('');
  });

  it('applies gap 0 — an explicit zero is not "unset"', () => {
    const { container } = render(
      <Stack gap={0}>
        <span>a</span>
      </Stack>,
    );
    expect((container.firstElementChild as HTMLElement).style.gap).toBe('0px');
  });

  it('carries direction, alignment, justification and wrap through to inline style', () => {
    const { container } = render(
      <Stack direction="row" gap={8} align="center" justify="space-between" wrap className="bar">
        <span>a</span>
      </Stack>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className.split(/\s+/)).toEqual(expect.arrayContaining(['nd-stack','nt-stack','nt-stack--row','nt-stack--wrap','bar']));
    expect(el.style.flexDirection).toBe('row');
    expect(el.style.gap).toBe('8px');
    expect(el.style.alignItems).toBe('center');
    expect(el.style.justifyContent).toBe('space-between');
    expect(el.style.flexWrap).toBe('wrap');
  });

  it('lets a caller style override the computed defaults', () => {
    const { container } = render(
      <Stack direction="row" style={{ display: 'grid' }}>
        <span>a</span>
      </Stack>,
    );
    expect((container.firstElementChild as HTMLElement).style.display).toBe('grid');
  });
});

describe('Card', () => {
  it.each([
    [undefined, 'nd-card--soft'],
    ['soft', 'nd-card--soft'],
    ['plain', 'nd-card--plain'],
  ] as const)('maps variant %s onto %s', (variant, expected) => {
    const { container } = render(<Card variant={variant}>x</Card>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('nd-card');
    expect(el.className).toContain(expected);
  });

  it('appends a caller className and style', () => {
    const { container } = render(
      <Card className="tall" style={{ padding: 4 }}>
        x
      </Card>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('tall');
    expect(el.style.padding).toBe('4px');
  });
});

describe('Divider', () => {
  it('exposes the separator role and defaults to the plain variant', () => {
    render(<Divider />);
    expect(screen.getByRole('separator').className).toBe('nd-divider nd-divider--default');
  });

  it('carries the flair variant', () => {
    render(<Divider variant="flair" />);
    expect(screen.getByRole('separator').className).toContain('nd-divider--flair');
  });
});

describe('SectionHeader', () => {
  it('always renders the label and renders meta only when present', () => {
    const { container, rerender } = render(<SectionHeader label="Needs you now" />);
    expect(screen.getByText('Needs you now').className).toContain('nd-micro-label');
    expect(screen.getByText('Needs you now').className).toContain('nt-micro-label');
    expect(container.querySelector('.nd-section-header__meta')).toBeNull();

    rerender(<SectionHeader label="Needs you now" meta="3" />);
    expect(container.querySelector('.nd-section-header__meta')?.textContent).toBe('3');
  });
});

describe('Heading', () => {
  it('defaults to an h2', () => {
    render(<Heading>Sites</Heading>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Sites');
  });

  it.each([1, 2, 3, 4] as const)('renders level %s as its own tag with a matching class', (level) => {
    render(<Heading level={level}>Sites</Heading>);
    const h = screen.getByRole('heading', { level });
    expect(h.tagName).toBe(`H${level}`);
    expect(h.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'nd-heading',
        'nt-heading',
        `nd-heading--${level}`,
        `nt-heading--${level}`,
      ]),
    );
  });

  it('renders the overline outside the heading so it is not part of the accessible name', () => {
    render(
      <Heading level={1} overline="PLANE">
        Central
      </Heading>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Central');
    expect(screen.getByText('PLANE').className).toContain('nd-heading__overline');
  });
});

describe('Text', () => {
  it('defaults to a 14/primary span', () => {
    const { container } = render(<Text>hello</Text>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe('SPAN');
    expect(el.style.fontSize).toBe('var(--nd-text-14)');
    expect(el.style.color).toBe('var(--nd-text-primary)');
  });

  it.each([
    ['secondary', 'var(--nd-text-secondary)'],
    ['muted', 'var(--nd-text-muted)'],
  ] as const)('maps tone %s onto %s', (tone, expected) => {
    const { container } = render(<Text tone={tone}>hello</Text>);
    expect((container.firstElementChild as HTMLElement).style.color).toBe(expected);
  });

  it('maps the accent tone onto the accent-text token, not --nd-text-accent', () => {
    // There is no --nd-text-accent variable; resolving it would paint nothing.
    const { container } = render(<Text tone="accent">hello</Text>);
    expect((container.firstElementChild as HTMLElement).style.color).toBe('var(--nd-accent-text)');
  });

  it('maps the size scale onto the matching token', () => {
    const { container } = render(<Text size={26}>hello</Text>);
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe('var(--nd-text-26)');
  });

  it('switches font family for mono and serif, and lets serif win when both are set', () => {
    const { container: mono } = render(<Text mono>x</Text>);
    expect((mono.firstElementChild as HTMLElement).style.fontFamily).toBe('var(--nd-font-mono)');

    const { container: serif } = render(<Text serif italic>x</Text>);
    const el = serif.firstElementChild as HTMLElement;
    expect(el.style.fontFamily).toBe('var(--nd-font-display)');
    expect(el.style.fontStyle).toBe('italic');
  });

  it.each(['p', 'div'] as const)('renders as %s when asked', (as) => {
    const { container } = render(<Text as={as}>hello</Text>);
    expect((container.firstElementChild as HTMLElement).tagName).toBe(as.toUpperCase());
  });
});

describe('Code', () => {
  it('renders inline code by default', () => {
    const { container } = render(<Code>show version</Code>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe('CODE');
    expect(el.className).toContain('nd-code');
    expect(el.className).toContain('nt-code-inline');
  });

  it('wraps block code in a pre so whitespace survives', () => {
    const { container } = render(<Code block>{'line one\nline two'}</Code>);
    const pre = container.firstElementChild as HTMLElement;
    expect(pre.tagName).toBe('PRE');
    expect(pre.className).toContain('nd-code-block');
    expect(pre.className).toContain('nt-code-frame');
    expect(pre.querySelector('code')?.textContent).toBe('line one\nline two');
  });
});

describe('Kbd', () => {
  it('renders a kbd element', () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe('KBD');
    expect(el.className).toContain('nd-kbd');
    expect(el.className).toContain('nt-kbd');
  });
});
