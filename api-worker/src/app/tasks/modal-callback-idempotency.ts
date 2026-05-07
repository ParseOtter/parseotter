export function createModalCallbackIdempotencyKey(taskId: string, attempt: number): string {
  return `${taskId}:callback:${attempt}`
}
