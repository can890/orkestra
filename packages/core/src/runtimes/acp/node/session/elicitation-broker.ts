import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { AcpElicitationAction, AcpElicitationContent, AcpElicitationRequest } from '#runtimes/acp/api';

type ElicitationResolver = (response: CreateElicitationResponse) => void;

export class ElicitationBroker {
  private readonly resolvers = new Map<string, ElicitationResolver>();

  request(request: AcpElicitationRequest): Promise<CreateElicitationResponse> {
    return new Promise<CreateElicitationResponse>((resolve) => {
      this.resolvers.set(request.requestId, resolve);
    });
  }

  settle(
    requestId: string,
    action: AcpElicitationAction,
    content?: AcpElicitationContent
  ): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    if (action === 'accept') {
      resolver({ action: 'accept', content: content ?? {} });
    } else if (action === 'decline') {
      resolver({ action: 'decline' });
    } else {
      resolver({ action: 'cancel' });
    }
    return true;
  }

  cancel(requestId: string): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    resolver({ action: 'cancel' });
    return true;
  }

  drain(requests: readonly AcpElicitationRequest[]): void {
    for (const request of requests) {
      this.cancel(request.requestId);
    }
  }
}
