// Stop joins a recording's stored chunks into one file (audio in the offscreen document, video and a closed
// recorder's audio in the service worker).
//
// A chunk read back from IndexedDB is a blob that IndexedDB serves, not bytes this page holds. Chromium registers such
// a blob with its blob registry only while a page holds it, and lazily; a `new Blob([...chunks])` that names one the
// registry does not have at that moment is a "bad blob reference", and Chromium kills the whole extension process for
// it: the panel, the offscreen document, every extension page and the service worker (seen on the Linux CI runners as
// "Terminating render process for bad Mojo message: Received bad user message: Bad blob references in
// BlobRegistry::Register", then the extension's tabs killed mid-Stop). Reading each chunk's bytes asks nothing of the
// registry, and a chunk that cannot be read yet fails that one read (NotReadableError), which the caller can retry.

//
// Each chunk's bytes become a Blob of this page's own straight away, so only one chunk is ever held as an ArrayBuffer:
// a long Session's video runs to hundreds of megabytes, and holding every chunk's bytes at once in the service worker
// could run it out of memory at Stop. The browser keeps its own blobs out of the page's heap (Chromium pages large ones
// to disk), and joining those names only blobs the registry already has.

/** The chunks' bytes, in order, as one Blob of `type`. Never builds a Blob out of the chunks themselves. */
export async function joinChunks(chunks: Blob[], type: string): Promise<Blob> {
  const parts: Blob[] = [];
  for (const chunk of chunks) parts.push(new Blob([await chunk.arrayBuffer()]));
  return new Blob(parts, { type });
}
