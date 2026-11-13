import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';
  size?: 'md' | 'sm';
  icon?: IconName;
  /** Shows a spinner and disables the button while an action is in flight. */
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : '',
    children === undefined ? 'btn-icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <span className='spinner' aria-hidden='true' />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 15} />
      ) : null}
      {children}
    </button>
  );
}
