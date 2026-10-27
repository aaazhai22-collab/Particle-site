const pendingExamples = new Map<string, Promise<Blob>>();

/** Share only in-flight downloads; each import still owns its File and scene. */
export function loadExampleBlob(url: string, failureMessage: string): Promise<Blob> {
  let request = pendingExamples.get(url);
  if (!request) {
    request = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Example request failed: ${response.status}`);
      return response.blob();
    })();
    pendingExamples.set(url, request);
    const clear = () => {
      if (pendingExamples.get(url) === request) pendingExamples.delete(url);
    };
    // Handle both outcomes without creating an unobserved rejected cleanup promise.
    void request.then(clear, clear);
  }
  return request.catch(error => { throw new Error(failureMessage, { cause: error }); });
}
