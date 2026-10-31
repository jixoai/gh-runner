let sequence = 0;

export function createRequestId(): string {
  sequence += 1;
  return `${Date.now()}-${sequence}`;
}
