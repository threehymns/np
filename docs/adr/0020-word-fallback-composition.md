# The word fallback is decided per query, by the source that has to answer for it

`words` gained a third mode, `'fallback'`, and it became the default: server items
answer a query in a served language, and words answer behind a server that errors
or times out. This records the two decisions that shape it — what counts as a
failure, and who is allowed to decide.

## Three outcomes, not two

A completion query ends in one of three states, and the runtime reports which.
`inactive` means nothing was ever meant to answer: no descriptor claims the
language, no transport exists, the user set `lsp: false`, or the runtime is
shutting down. `serving` means a server answered. `unavailable` means one was
there and could not deliver — it would not start, it failed the request, or it
answered too late.

Collapsing the last two would make a wedged server indistinguishable from a file
nothing serves, which is the silence this mode exists to remove. Keeping `inactive`
separate from `unavailable` is what keeps prose unaffected: a Markdown note has no
server, so it is `inactive` and its words answer exactly as they did before any
server existed, rather than reading as a degradation the mode introduced.

## The words source decides, and it decides late

The decision is made inside the buffer-word source, on every query, after the
server's answer for that same query has settled. Two alternatives were rejected.
Composing the chain per query would mean rebuilding the language-data facet on
every keystroke. Handing the words source the server's state at *configuration*
time would have to guess, and the guess that is wrong in the direction of
"serving" is exactly the failure `fallback` exists to prevent.

So the two sources share one coordinator, and the chain order is load-bearing
rather than cosmetic: the server source is registered first and records its query
synchronously, before returning the promise, so the words source — asked
immediately after in the same pass — waits on that exact query. Moving the server
source below the words source would break the fallback silently.

`inactive` is settled synchronously rather than through a promise, so a document
with no server pays nothing and the words source still answers in the same tick it
always did.

## The five settings are per language, and one of them is a number of zero

`lsp`, `lsp_fetch_timeout_ms`, `lsp_insert_mode` and
`show_completion_documentation` are scoped per language like `words`, because the
question each one answers is per language. `automatic_completions` remains global
because it is the popup's own switch, not a statement about a language.

`lsp_fetch_timeout_ms` defaults to `0`, which means *no bound* — the popover waits
for whichever server is answering. That travels to the client as `undefined`
rather than as a zero timer: a zero timer would make the documented default an
instant failure, which is the opposite of what it says. Zed's default is the
reason this is easy to get backwards.

`'enabled'` and `'disabled'` keep the meanings they had. `'disabled'` still silences
the automatic trigger only, and still answers the explicit one; `'enabled'` is not
a synonym for the old default, because it does not stand down behind a server.

## Server items rank with the notes, not above them

The boost for a server item is the note tier's, `0`. `sortOptions` orders a ranked
section strictly ahead of every unranked one before the fuzzy score is consulted,
so a numbered section would promote server items above the note sources — which
are frozen and un-sectioned, and cannot be changed to accommodate a new tier.
Tying the boost means a server item and a note option are ordered by how well
their labels match, which is what "in the composed order" claims and is a weaker
claim than ranking above the notes would be. Snippets and words stay below both.

One thing measured while writing the tests is worth recording: `@codemirror/
lang-javascript` registers its own unboosted source offering the document's
identifiers. In a TypeScript file it is a fourth unboosted source on the chain,
beside the notes, and the server tier sits with it rather than below it.

## A named range, and what a completion item may say

`lsp_insert_mode` is what makes `CompletionItem.textEdit.range` matter, so the range
survives the crossing from the plugin to the editor as data rather than being
decoded at the presentation edge — otherwise `replace_range` would silently
degrade into `replace_suffix`. A range is clamped into the document at apply time,
because a range the server computed against an older revision can point past its
end, and an out-of-bounds offset throws in every consumer of one.

`completionItem/resolve` is not used. vtsls advertises `resolveProvider: true`, and
a real server often withholds documentation until it is asked — so most items will
show a signature and no JSDoc. CodeMirror has no public hook for "the popover is
now showing this option", so the round trip has nowhere to hang. Doing it anyway
means N requests per keystroke, or a cache that lands the docs one keystroke late.
That is a design of its own and it belongs with hover, which spec #263 defers for
the same reason.

## What is asserted, and where

The fallback is asserted against the scripted stub over a real process: words
answer when the stub fails the request, when it fails to start, and when its reply
arrives later than the bound — with the bound's effect measured against the stub's
own delay rather than observed as an eventual answer. Rank is asserted on the real
popover through `currentCompletions` off a mounted view, as in ADR 0018. The
insert modes are asserted on the resulting document, because the only difference
between them is what a transaction replaces.