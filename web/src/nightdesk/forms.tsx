import { cloneElement, isValidElement, useId, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from './utils';

/* ---------- Button ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * `danger` is the destructive variant (retire a plane, revoke a credential).
   * It exists so a destructive control never has to be a ghost button wearing
   * an inline `color: var(--nd-danger)` — the intent belongs in the variant,
   * where hover/active/focus states come with it.
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('nd-btn', `nd-btn--${variant}`, `nd-btn--${size}`, className)}
      {...rest}
    />
  );
}

/* ---------- Input / Textarea ---------- */

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: 'sm' | 'md' | 'lg';
  mono?: boolean;
};

export function Input({ size = 'md', mono, className, id, ...rest }: InputProps) {
  const generatedId = useId();
  return (
    <input
      id={id ?? generatedId}
      className={cx('nd-input', `nd-input--${size}`, mono && 'nd-input--mono', className)}
      {...rest}
    />
  );
}

export function Textarea({
  mono,
  className,
  id,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  const generatedId = useId();
  return <textarea id={id ?? generatedId} className={cx('nd-textarea', mono && 'nd-textarea--mono', className)} {...rest} />;
}

/* ---------- Select ---------- */

export type SelectOption = { value: string; label: string };

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  size?: 'sm' | 'md' | 'lg';
  options?: SelectOption[];
  onValueChange?: (value: string) => void;
};

export function Select({
  size = 'md',
  options,
  onValueChange,
  onChange,
  className,
  children,
  id,
  ...rest
}: SelectProps) {
  const generatedId = useId();
  return (
    <span className={cx('nd-select-wrap', className)}>
      <select
        id={id ?? generatedId}
        className={`nd-select nd-select--${size}`}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          : children}
      </select>
    </span>
  );
}

/* ---------- Checkbox ---------- */

export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode }) {
  return (
    <label className={cx('nd-checkbox', className)}>
      <input type="checkbox" {...rest} />
      {label != null ? <span>{label}</span> : null}
    </label>
  );
}

/* ---------- Switch ---------- */

type SwitchProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  size?: 'sm' | 'md';
  disabled?: boolean;
  'aria-label'?: string;
};

export function Switch({
  checked,
  defaultChecked,
  onCheckedChange,
  label,
  size = 'md',
  disabled,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const [inner, setInner] = useState(!!defaultChecked);
  const isOn = checked !== undefined ? checked : inner;
  const toggle = () => {
    if (disabled) return;
    const next = !isOn;
    if (checked === undefined) setInner(next);
    onCheckedChange?.(next);
  };
  return (
    <label className={cx('nd-switch', disabled && 'nd-switch--disabled')}>
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cx(
          'nd-switch__track',
          size === 'sm' && 'nd-switch__track--sm',
          isOn && 'nd-switch__track--on',
        )}
        onClick={toggle}
      >
        <span className="nd-switch__knob" />
      </button>
      {label != null ? <span className="nd-switch__label">{label}</span> : null}
    </label>
  );
}

/* ---------- FormField ---------- */

export function FormField({
  label,
  help,
  htmlFor,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children)
    ? cloneElement(children, { id: children.props.id ?? htmlFor ?? generatedId })
    : children;
  const labelFor = htmlFor ?? (isValidElement<{ id?: string }>(child) ? child.props.id : undefined);

  return (
    <div className="nd-field">
      <label className="nd-micro-label" htmlFor={labelFor}>
        {label}
      </label>
      {child}
      {help ? <div className="nd-field__help">{help}</div> : null}
    </div>
  );
}

/* ---------- SegmentedControl ---------- */

export function SegmentedControl({
  options,
  value,
  onValueChange,
  ariaLabel,
}: {
  options: Array<{ value: string; label: ReactNode }>;
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="nd-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={cx('nd-seg__btn', o.value === value && 'nd-seg__btn--active')}
          onClick={() => onValueChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
