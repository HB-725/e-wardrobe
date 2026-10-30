import { useCallback } from 'react';
import { describeAiError } from '@/ai/client';
import { useApp } from './app';

/**
 * Wraps an async event handler so a failure shows a toast instead of disappearing
 * (release builds swallow unhandled promise rejections, leaving spinners stuck).
 */
export function useSafe() {
  const { toast } = useApp();
  return useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) =>
      async (...args: A) => {
        try {
          await fn(...args);
        } catch (e) {
          console.warn(e);
          toast(`没有完成：${describeAiError(e)}`);
        }
      },
    [toast],
  );
}
