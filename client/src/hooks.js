import { useEffect, useRef, useState } from 'react';
export function useResource(key, fetcher) {
  // Keep the current fetcher without restarting the effect on every render.
  const latestFetcher = useRef(fetcher);
  latestFetcher.current = fetcher;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ key: null, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    setState({ key, loading: true });
    Promise.resolve()
      .then(() => latestFetcher.current(controller.signal))
      .then((data) => {
        if (isActive) {
          setState({ key, data, loading: false });
        }
      })
      .catch((error) => {
        if (isActive && !controller.signal.aborted) {
          setState({ key, error, loading: false });
        }
      });
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [key, version]);
  return {
    ...(state.key === key ? state : { loading: true }),
    reload: () => setVersion((value) => value + 1),
  };
}
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const isRunning = useRef(false);
  const controller = useRef(null);
  const isMounted = useRef(false);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function run(task) {
    // A ref blocks duplicate submissions before React renders the pending state.
    if (isRunning.current) {
      return;
    }
    isRunning.current = true;
    controller.current = new AbortController();
    setPending(true);
    setError('');
    try {
      return await task(controller.current.signal);
    } catch (failure) {
      if (isMounted.current && !controller.current.signal.aborted) {
        setError(failure.message || 'Please try again.');
      }
    } finally {
      isRunning.current = false;
      if (isMounted.current) {
        setPending(false);
      }
    }
  }
  return { pending, error, setError, run };
}
