import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Button,
  Checkbox,
  FormField,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from './forms';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Button', () => {
  it('composes the base class with the variant and size, defaulting to secondary/md', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className.split(' ')).toEqual(['nd-btn', 'nd-btn--secondary', 'nd-btn--md', 'nt-btn']);
  });

  it.each([
    ['primary', 'nd-btn--primary'],
    ['secondary', 'nd-btn--secondary'],
    ['ghost', 'nd-btn--ghost'],
    ['danger', 'nd-btn--danger'],
  ] as const)('maps variant %s onto %s', (variant, expected) => {
    render(<Button variant={variant}>Retire</Button>);
    expect(screen.getByRole('button', { name: 'Retire' }).className).toContain(expected);
  });

  it('carries the destructive intent in the variant, not an inline colour', () => {
    // Regression guard: 'Retire plane' used to be a ghost button wearing an
    // inline `color: var(--nd-danger)`, which loses hover/active/focus states.
    render(
      <Button variant="danger" size="sm">
        Retire plane
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Retire plane' });
    expect(btn.className.split(' ')).toEqual(['nd-btn', 'nd-btn--danger', 'nd-btn--sm', 'nt-btn']);
    expect(btn.getAttribute('style')).toBeNull();
  });

  it.each(['sm', 'md', 'lg'] as const)('maps size %s onto its own class', (size) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain(`nd-btn--${size}`);
  });

  it('appends a caller className without dropping the design-system classes', () => {
    render(<Button className="my-own">Go</Button>);
    const cls = screen.getByRole('button', { name: 'Go' }).className;
    expect(cls).toContain('nd-btn');
    expect(cls).toContain('nd-btn--secondary');
    expect(cls).toContain('my-own');
  });

  it('defaults to type="button" so a control inside a form never submits it by accident', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Test connection</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still submits when the caller explicitly asks for type="submit"', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('suppresses onClick while disabled — a control that cannot act must be inert', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Reclaim all
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Reclaim all' });
    expect(btn.hasAttribute('disabled')).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Input / Textarea', () => {
  it('maps size and mono onto classes and keeps size off the DOM attribute', () => {
    render(<Input size="sm" mono aria-label="Endpoint" defaultValue="apigw" />);
    const input = screen.getByLabelText('Endpoint');
    expect(input.className.split(' ')).toEqual(['nd-input', 'nd-input--sm', 'nd-input--mono', 'nt-input', 'nt-field']);
    // `size` is a nightdesk scale token, not the HTML character-width attribute.
    expect(input.hasAttribute('size')).toBe(false);
  });

  it('omits the mono class when not asked for and defaults to md', () => {
    render(<Input aria-label="Site" />);
    expect(screen.getByLabelText('Site').className.split(' ')).toEqual(['nd-input', 'nd-input--md', 'nt-input', 'nt-field']);
  });

  it('renders a masked credential value verbatim without unmasking it', () => {
    // Screens hand the server's maskedView() string straight to Input; the
    // component must never reformat or reveal it.
    render(<Input readOnly mono aria-label="API key" value="••••••••3f9a" onChange={() => {}} />);
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('••••••••3f9a');
    expect(screen.getByLabelText('API key').hasAttribute('readonly')).toBe(true);
  });

  it('marks a required field on the DOM so the browser and AT both see it', () => {
    render(<Input required aria-label="Endpoint" />);
    expect(screen.getByLabelText('Endpoint').hasAttribute('required')).toBe(true);
  });

  it('composes the textarea mono class', () => {
    render(<Textarea mono aria-label="Config" />);
    expect(screen.getByLabelText('Config').className.split(' ')).toEqual([
      'nd-textarea',
      'nd-textarea--mono',
      'nt-textarea',
      'nt-field',
      'nt-field--area',
    ]);
  });
});

describe('Select', () => {
  it('renders the options array and reports the chosen value to both handlers', () => {
    const onChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Plane"
        defaultValue="central"
        options={[
          { value: 'central', label: 'Central' },
          { value: 'mist', label: 'Mist' },
        ]}
        onChange={onChange}
        onValueChange={onValueChange}
      />,
    );
    const select = screen.getByLabelText('Plane') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['central', 'mist']);

    fireEvent.change(select, { target: { value: 'mist' } });
    expect(onValueChange).toHaveBeenCalledWith('mist');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('falls back to children when no options array is supplied', () => {
    render(
      <Select aria-label="Plane" defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    expect((screen.getByLabelText('Plane') as HTMLSelectElement).options).toHaveLength(2);
  });

  it('keeps the size token on the inner select and the caller class on the wrapper', () => {
    const { container } = render(<Select aria-label="Plane" size="sm" className="wide" options={[]} />);
    expect(container.querySelector('.nd-select-wrap')?.className).toContain('wide');
    expect(screen.getByLabelText('Plane').className).toContain('nd-select');
    expect(screen.getByLabelText('Plane').className).toContain('nd-select--sm');
    expect(screen.getByLabelText('Plane').className).toContain('nt-field');
  });
});

describe('Checkbox', () => {
  it('associates the label text with the input and reports toggles', () => {
    const onChange = vi.fn();
    render(<Checkbox label="Dry run" onChange={onChange} />);
    const box = screen.getByLabelText('Dry run') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders no label span when no label is given', () => {
    const { container } = render(<Checkbox aria-label="bare" />);
    expect(container.querySelector('.nd-checkbox span')).toBeNull();
  });
});

describe('Switch', () => {
  it('self-toggles when uncontrolled and reports the next value', () => {
    const onCheckedChange = vi.fn();
    render(<Switch label="Demo mode" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.className).toContain('nd-switch__track--on');

    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('honours defaultChecked for the uncontrolled starting position', () => {
    render(<Switch defaultChecked label="Demo mode" />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('never moves on its own when controlled — the owner state decides', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Demo mode" />);
    const sw = screen.getByRole('switch');

    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    // The prop still says false, so the rendered state must still say false.
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.className).not.toContain('nd-switch__track--on');
  });

  it('is inert while disabled and says so in the class', () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Switch disabled onCheckedChange={onCheckedChange} label="Demo mode" />);
    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('disabled')).toBe(true);
    fireEvent.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('.nd-switch')?.className).toContain('nd-switch--disabled');
  });

  it('adds the small track class only at size sm', () => {
    const { rerender } = render(<Switch size="sm" aria-label="a" />);
    expect(screen.getByRole('switch').className).toContain('nd-switch__track--sm');
    rerender(<Switch aria-label="a" />);
    expect(screen.getByRole('switch').className).not.toContain('nd-switch__track--sm');
  });
});

describe('FormField', () => {
  it('generates an id, stamps it on the control and points the label at it', () => {
    render(
      <FormField label="Endpoint">
        <Input defaultValue="apigw-prod2-us-west-2" />
      </FormField>,
    );
    const input = screen.getByLabelText('Endpoint') as HTMLInputElement;
    expect(input.id).not.toBe('');
    expect(input.value).toBe('apigw-prod2-us-west-2');
  });

  it('prefers an explicit htmlFor over the generated id', () => {
    render(
      <FormField label="Endpoint" htmlFor="endpoint-field">
        <Input />
      </FormField>,
    );
    expect((screen.getByLabelText('Endpoint') as HTMLInputElement).id).toBe('endpoint-field');
  });

  it("leaves a child's own id alone", () => {
    render(
      <FormField label="Endpoint" htmlFor="ignored">
        <Input id="mine" />
      </FormField>,
    );
    expect(document.getElementById('mine')).not.toBeNull();
    expect(document.getElementById('ignored')).toBeNull();
  });

  it('wires the label through to a Select child too', () => {
    render(
      <FormField label="Plane">
        <Select options={[{ value: 'central', label: 'Central' }]} />
      </FormField>,
    );
    expect((screen.getByLabelText('Plane') as HTMLSelectElement).value).toBe('central');
  });

  it('renders optional help text only when supplied', () => {
    const { container, rerender } = render(
      <FormField label="Endpoint" help="Origin only — no path">
        <Input />
      </FormField>,
    );
    expect(screen.getByText('Origin only — no path')).toBeTruthy();

    rerender(
      <FormField label="Endpoint">
        <Input />
      </FormField>,
    );
    expect(container.querySelector('.nd-field__help')).toBeNull();
  });

  it('still renders non-element children without crashing on cloneElement', () => {
    render(<FormField label="Recorded">— not reported by this plane</FormField>);
    expect(screen.getByText('— not reported by this plane')).toBeTruthy();
  });
});

describe('SegmentedControl', () => {
  it('marks exactly the selected option and reports the other one when clicked', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Data source"
        value="live"
        onValueChange={onValueChange}
        options={[
          { value: 'live', label: 'Live' },
          { value: 'demo', label: 'Demo' },
        ]}
      />,
    );
    expect(screen.getByRole('tablist', { name: 'Data source' })).toBeTruthy();
    const live = screen.getByRole('tab', { name: 'Live' });
    const demo = screen.getByRole('tab', { name: 'Demo' });
    expect(live.getAttribute('aria-selected')).toBe('true');
    expect(live.className).toContain('nd-seg__btn--active');
    expect(demo.getAttribute('aria-selected')).toBe('false');
    expect(demo.className).not.toContain('nd-seg__btn--active');

    fireEvent.click(demo);
    expect(onValueChange).toHaveBeenCalledWith('demo');
  });
});
