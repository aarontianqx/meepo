export type DomainErrorCode = 'not_found' | 'validation' | 'conflict' | 'unauthorized';

/** Error raised by domain services; transport layers map `code` to HTTP/RPC errors. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const notFound = (message: string): DomainError => new DomainError('not_found', message);
export const validation = (message: string): DomainError => new DomainError('validation', message);
export const conflict = (message: string): DomainError => new DomainError('conflict', message);
export const unauthorized = (message: string): DomainError =>
  new DomainError('unauthorized', message);
