# Completion sources compose by appending to the language's data facet

Completion sources are host-composed, not contributed as CodeMirror extensions. The host owns one `autocompletion()` instance and registers each source as a separate input on the active language's `data` facet, in its own compartment, placed after the compartment that registers the language itself. This is what makes the composition append rather than replace, and it is the reason the editor has exactly one place to express the two settings that reach the whole chain at once.

## Registration order is chain order

A language's `data` facet concatenates its inputs in configuration order, and `languageDataAt` resolves them through the active language, so the order the sources are registered in is the order CodeMirror consults them. Registering in a compartment after the language compartment therefore appends to the chain the language already built — the table and wikilink sources stay exactly where they were — rather than reordering it. Registering each source separately rather than merging them into one is deliberate too: CodeMirror filters each source's options against that source's own `from`/`to`, so a merged source would force a single match range onto the wikilink source and break its bracket-aware matching.

`autocompletion({ override })` is rejected for the same reason. `override` replaces the language-data chain outright, which would silently drop the table and wikilink sources along with every other plugin's future source. Nothing is gained by it here and the note sources are lost, so it is not used.

## Ranking uses boost, not sections

Rank tiers are expressed as `boost` on each option, not as completion sections. CodeMirror's sorting orders a ranked section strictly ahead of every unranked one, before the fuzzy score is even consulted, so introducing sections would promote the snippet tier above the note sources no matter what value it carried. The existing note sources are un-sectioned and frozen — they are not modified to accommodate a new tier — so the only lever that can place a new source below them without touching them is the score itself.

Every fuzzy score CodeMirror computes is `<= 0` and bottoms out near `-2100 - word length`, so a boost below that floor is an unconditional ranking rather than one that depends on how well the typed prefix happens to fuzzy-match the label. The note sources carry no boost at all and stay first; the snippet tier sits between the floor and the word tier; words sit below both.

## Exactly one autocompletion() per editor state

Only one `autocompletion()` may exist in a given editor state. `combineConfig` throws `"Config merge conflict for field X"` when two `autocompletion()` inputs disagree on a field that has no combiner, and every field in its configuration is such a field. A second instance configured differently therefore crashes the editor state instead of overriding the first.

The consequences shape where the settings live. The global popup toggle (`activateOnTyping`) has to reach the language-provided sources, which are not reachable per source, and the modal keymap (`defaultKeymap`) has to replace the one `autocompletion()` installs. Both are therefore expressed on the single instance the host owns, and both live in the same compartment: it is the one place a reconfiguration can swap them. Adding a source is cheap; adding a second `autocompletion()` is not.

## Vim: Enter is unbound, Ctrl-y accepts

`completionKeymap` binds Enter to `acceptCompletion` and is installed at `Prec.highest`, so a completion in a code file — where words fire on their own — sits one keystroke away from a key a vim insert-mode user means as a newline.

No conflict is observed today, and the reason is not a guarantee: `@replit/codemirror-vim` claims insert-mode Enter before CodeMirror's keymap sees it. That ordering is the vim extension's implementation detail, not a contract, and the `Prec.highest` binding is the kind of thing a vim update or a future source could expose. So under vim the compartment passes `defaultKeymap: false` and supplies the same bindings **minus Enter**, plus `Ctrl-y` bound to `acceptCompletion`, which is vim's own insert-mode accept. Every other binding is kept verbatim, so the explicit trigger and the selection keys do not move.

Acceptance was the binding that was genuinely missing: before this, a vim user had a way to summon completions and no key to accept one.

## Snippets are a sibling registry, not an editor contribution

Spec #194 anticipated a completion contribution type extending the editor contribution pattern. The snippet pack is a sibling *data* registry mirroring `languages.ts`, not a new `EditorContributionType`, and the deviation is deliberate.

`EditorContribution.extension` is a bare CodeMirror `Extension`. A completion source is not an `Extension` until it has a language to attach to, and a pack that names a language another contribution registered cannot supply one itself — there is no editor contribution it could be that would survive without a `Language` in hand. A pack is data: typed triggers with plain bodies joined on a language identity, with no placeholders and no snippet variables, because expanding tab stops is out of scope. That is the shape a registry already holds and replays, so the snippet pack is declared as one: the host materializes records from plugin transforms with an owning plugin, and the editor turns the current language's records into a completion source.

Ownership follows the record, not the transform that ran last: a record that arrives with an empty owner is claimed by the transform that emitted it, and a record that already carries an owner keeps it. That is what makes a refresh transform safe — one that re-emits records it did not change, with a fresh object identity, leaves them alone instead of re-attributing them to whoever ran last.

## What is asserted, and where

Ranking is asserted on the real popover order, read through the public `currentCompletions` off a mounted view, because the sorter is not exported and the completion state only builds a dialog once the view plugin has run the sources. Whether CodeMirror asked a source at all, and whether it marked the question explicit, are asserted through the public `CompletionContext` a source receives. No test on this path reads a CodeMirror internal.
