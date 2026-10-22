import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { QueryKey, QueryObserverOptions } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: 'always',
        gcTime: 0,
      },
    },
  });
}

export const queryClient = createQueryClient();

// Give a loader an observer lease. Releasing its final lease cancels Query's
// signal, but leaving a route must not cancel another consumer of the same key.
export async function loadQuery<T, TKey extends QueryKey>(
  client: QueryClient,
  options: QueryObserverOptions<T, Error, T, T, TKey>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const observer = new QueryObserver(client, { ...options, refetchOnMount: false });
  const unsubscribe = observer.subscribe(() => {});
  let onAbort = () => {};
  try {
    await Promise.race([
      observer.refetch({ cancelRefetch: false, throwOnError: true }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          unsubscribe();
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}
