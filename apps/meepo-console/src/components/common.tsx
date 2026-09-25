import type { ReactNode } from 'react';

export function ErrorBanner({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null;
  return <p className='error-banner'>{error}</p>;
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className='card'>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
