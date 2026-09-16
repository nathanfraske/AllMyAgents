# Math and image viewing in chat

Chat Markdown renders inline LaTeX with `\( … \)` or `$ … $`, and display
equations with `\[ … \]` or `$$ … $$`. This applies to both providers and
existing loaded history, without rewriting the journal. Backticks/fenced code
remain literal, and ordinary prices such as `$5 and $10` are not equations.
Invalid/unsupported formulas remain readable as source instead of breaking the reply.

KaTeX is pinned and bundled locally; its MathML passes through the existing
DOMPurify prose sanitizer. No CDN, remote image, font fetch, trusted HTML commands,
or shared macro definitions are enabled. Rendering is capped at 128 expressions per
message, 8,192 characters per expression, 100 macro expansions, and 10em user sizes.
Delimiter searches share a 256 KiB scan budget so unfinished streaming expressions
cannot cause quadratic rescans of the whole message; excess content stays literal.
The completed-formula cache is bounded to 128 entries / 512 KiB; ordinary non-math
messages keep the original parser path. Copying a rendered equation preserves TeX.

Click an image attachment (user upload or agent publication) to open a modal filling
the application content window. This does not enter OS fullscreen. Left/Right arrows
and the Previous/Next buttons cycle through the current conversation's **loaded**
images in transcript order, wrapping at either end. Other chats and file downloads
are excluded. Older, unloaded history is not fetched merely to build a gallery.

Escape or Close exits the viewer and restores focus without moving the transcript.
Escape's keydown, held repeats and keyup are consumed so one press cannot also
dismiss an underlying dialog or trigger another chat action. Native modal focus
keeps background controls inert. Navigation keys stop at the viewer. Closing/unmounting
cleans up listeners; switching away from the app and back preserves keyboard handling.
Download and explicit failed-image retry remain available.

Verification: `markdownMath.test.ts`, `markdown.test.ts`, `ImageViewer.test.ts`,
`chatArtifacts.test.ts`, `attachmentReload.test.ts`, `transcriptCopy.test.ts`.
The browser fixture uses actual chat components without a live hub or vendor.
