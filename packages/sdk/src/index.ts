export * from '@meepo/core';
export * from '@meepo/protocol';

export interface MeepoClientOptions {
  serverUrl: string;
  authToken?: string;
}

export class MeepoClient {
  constructor(private readonly options: MeepoClientOptions) {}

  public getServerUrl(): string {
    return this.options.serverUrl;
  }
}
