import type { ReactNode } from 'react';
import { cx } from './utils';

type TableProps = {
  density?: 'comfortable' | 'compact';
  className?: string;
  /** Accessible name for the table — same contract as DataTable.ariaLabel. */
  ariaLabel?: string;
  children: ReactNode;
};

function TableRoot({ density = 'comfortable', className, ariaLabel, children }: TableProps) {
  return (
    <div className="nd-table-scroll nt-table-scroll">
      <table
        className={cx('nd-table', 'nd-table--open', density === 'compact' && 'nd-table--compact', className)}
        aria-label={ariaLabel}
      >
        {children}
      </table>
    </div>
  );
}

function Head({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>;
}

function Body({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

function Row({
  interactive,
  onClick,
  children,
}: {
  interactive?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <tr
      className={cx((interactive || onClick) && 'nd-table__tr--interactive')}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              // Only the row's own key presses navigate. Enter/Space inside a
              // nested control (an input being submitted, a button being
              // activated) belongs to that control, and swallowing it here
              // would fire row navigation on top of the control's own action.
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </tr>
  );
}

function HeaderCell({
  numeric,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <th className={cx('nd-table__th', numeric && 'nd-table__th--numeric', className)}>{children}</th>
  );
}

function Cell({
  numeric,
  colSpan,
  className,
  children,
}: {
  numeric?: boolean;
  colSpan?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx('nd-table__td', numeric && 'nd-table__td--numeric', className)}
    >
      {children}
    </td>
  );
}

export const Table = Object.assign(TableRoot, { Head, Body, Row, HeaderCell, Cell });
